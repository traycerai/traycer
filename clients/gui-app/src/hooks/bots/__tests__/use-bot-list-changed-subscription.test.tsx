/**
 * The `bot.listChanged` doorbell (Tracy Bots T24): while a bots surface is
 * mounted and the host advertises the method, a `changed` frame invalidates
 * every host's cached `bot.list`, a reconnect invalidates once more (it may
 * have missed a change), and nothing is subscribed anywhere else.
 *
 * Real hook over a real `QueryClient`; the stream transport is the PR suites'
 * shared fake. Invalidation is read off the cached `bot.list` queries
 * themselves, not off a spy on the invalidation helper.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { StreamFrameEnvelope } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { MockWsStreamClient } from "@/components/epic-canvas/pr/__tests__/pr-stream-test-fixtures";
import { useBotListChangedSubscription } from "@/hooks/bots/use-bot-list-changed-subscription";

type Support = "supported" | "unsupported" | "unknown";

const methodSupport = vi.hoisted<{ current: Support }>(() => ({
  current: "supported",
}));
vi.mock("@/lib/host/stream-runtime-context", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/host/stream-runtime-context")
  >()),
  useStreamMethodSupportFor: () => methodSupport.current,
}));

const HOST_A = "host-a";
const HOST_B = "host-b";
const CHANGED: StreamFrameEnvelope = {
  kind: "changed",
  hasBinaryPayload: false,
};

const queryClients: QueryClient[] = [];

function botListKey(hostId: string): readonly unknown[] {
  return hostQueryKeys.method<HostRpcRegistry, "bot.list">(
    hostId,
    "bot.list",
    {},
  );
}

/** Puts a fresh (not invalidated) `bot.list` answer in `hostId`'s scope. */
function seedBotList(queryClient: QueryClient, hostId: string): void {
  queryClient.setQueryData(botListKey(hostId), { bots: [] });
}

function isInvalidated(queryClient: QueryClient, hostId: string): boolean {
  const state = queryClient.getQueryState(botListKey(hostId));
  if (state === undefined) throw new Error(`no bot.list cached for ${hostId}`);
  return state.isInvalidated;
}

type Mounted = {
  readonly queryClient: QueryClient;
  readonly client: MockWsStreamClient<StreamFrameEnvelope>;
  readonly unmount: () => void;
};

function mount(enabled: boolean): Mounted {
  const queryClient = new QueryClient();
  queryClients.push(queryClient);
  seedBotList(queryClient, HOST_A);
  seedBotList(queryClient, HOST_B);
  const client = new MockWsStreamClient<StreamFrameEnvelope>();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const view = renderHook(
    () => useBotListChangedSubscription(client, enabled),
    {
      wrapper,
    },
  );
  return { queryClient, client, unmount: view.unmount };
}

function sessionOf(mounted: Mounted) {
  const session = mounted.client.getSession("bot.listChanged", {});
  if (session === undefined) throw new Error("bot.listChanged not subscribed");
  return session;
}

beforeEach(() => {
  methodSupport.current = "supported";
});

afterEach(() => {
  for (const queryClient of queryClients.splice(0)) queryClient.clear();
});

describe("useBotListChangedSubscription frames", () => {
  it("invalidates bot.list on every host scope when a changed frame arrives", () => {
    const mounted = mount(true);
    sessionOf(mounted).emitFrame(CHANGED);

    expect(isInvalidated(mounted.queryClient, HOST_A)).toBe(true);
    expect(isInvalidated(mounted.queryClient, HOST_B)).toBe(true);
  });

  it("leaves bot.list alone on a pong", () => {
    const mounted = mount(true);
    sessionOf(mounted).emitFrame({ kind: "pong", hasBinaryPayload: false });

    expect(isInvalidated(mounted.queryClient, HOST_A)).toBe(false);
    expect(isInvalidated(mounted.queryClient, HOST_B)).toBe(false);
  });

  it("leaves bot.list alone on a frame that does not parse", () => {
    const mounted = mount(true);
    sessionOf(mounted).emitFrame({ kind: "changed", hasBinaryPayload: true });

    expect(isInvalidated(mounted.queryClient, HOST_A)).toBe(false);
    expect(isInvalidated(mounted.queryClient, HOST_B)).toBe(false);
  });
});

describe("useBotListChangedSubscription reconnect", () => {
  it("invalidates nothing on the first open, and bot.list once the stream reopens", () => {
    const mounted = mount(true);
    const session = sessionOf(mounted);

    session.emitStatus("connecting", null);
    session.emitStatus("open", null);
    expect(isInvalidated(mounted.queryClient, HOST_A)).toBe(false);

    session.emitStatus("reconnecting", null);
    expect(isInvalidated(mounted.queryClient, HOST_A)).toBe(false);

    session.emitStatus("open", null);
    expect(isInvalidated(mounted.queryClient, HOST_A)).toBe(true);
    expect(isInvalidated(mounted.queryClient, HOST_B)).toBe(true);
  });

  it("invalidates again on every later reopen, not only the first", () => {
    const mounted = mount(true);
    const session = sessionOf(mounted);
    session.emitStatus("open", null);
    session.emitStatus("reconnecting", null);
    session.emitStatus("open", null);
    seedBotList(mounted.queryClient, HOST_A);
    expect(isInvalidated(mounted.queryClient, HOST_A)).toBe(false);

    session.emitStatus("reconnecting", null);
    session.emitStatus("open", null);

    expect(isInvalidated(mounted.queryClient, HOST_A)).toBe(true);
  });
});

describe("useBotListChangedSubscription lifetime", () => {
  it("closes the session once on unmount, and a late frame invalidates nothing", () => {
    const mounted = mount(true);
    const session = sessionOf(mounted);
    const close = vi.spyOn(session, "close");

    mounted.unmount();
    expect(close).toHaveBeenCalledTimes(1);

    session.emitFrame(CHANGED);
    expect(isInvalidated(mounted.queryClient, HOST_A)).toBe(false);
    expect(isInvalidated(mounted.queryClient, HOST_B)).toBe(false);
  });

  it("does not treat the reopen of a closed session as a reconnect", () => {
    const mounted = mount(true);
    const session = sessionOf(mounted);
    session.emitStatus("open", null);
    mounted.unmount();

    session.emitStatus("open", null);

    expect(isInvalidated(mounted.queryClient, HOST_A)).toBe(false);
  });
});

describe("useBotListChangedSubscription gating", () => {
  it("subscribes nothing while disabled", () => {
    const mounted = mount(false);

    expect(mounted.client.subscribeCallCount).toBe(0);
  });

  it.each<Support>(["unsupported", "unknown"])(
    "subscribes nothing while the host's support is %s",
    (support) => {
      methodSupport.current = support;
      const mounted = mount(true);

      expect(mounted.client.subscribeCallCount).toBe(0);
    },
  );

  it("subscribes to bot.listChanged once when enabled on a supporting host", () => {
    const mounted = mount(true);

    expect(mounted.client.subscribeCallCount).toBe(1);
    expect(mounted.client.getSession("bot.listChanged", {})).toBeDefined();
  });

  it("does nothing, and does not throw, without a client", () => {
    const queryClient = new QueryClient();
    queryClients.push(queryClient);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    expect(() =>
      renderHook(() => useBotListChangedSubscription(null, true), { wrapper }),
    ).not.toThrow();
  });
});
