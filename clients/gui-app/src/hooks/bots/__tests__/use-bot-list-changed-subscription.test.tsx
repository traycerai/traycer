/**
 * The `bot.listChanged` doorbell (Tracy Bots): while a bots surface is
 * mounted and the host advertises the method, a `changed` frame invalidates
 * every host's cached `bot.list`, a reconnect fetches nothing of its own
 * (the host's reconciliation `changed` covers it), and ONE subscription serves
 * a host however many surfaces read it, on however many clients.
 *
 * Real hook, real `useStreamMethodSupportFor`, real `QueryClient`. The only
 * fake is the stream transport: a `WsStreamClient` whose method support is a
 * settable value that notifies its listeners the way the real client's
 * `resetMethodSupport` / handshake do. Invalidation is read off the cached
 * `bot.list` queries, and counted off `invalidateQueries` where the count is
 * the claim.
 */
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import type {
  StreamCloseReason,
  StreamFrameEnvelope,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { MockWsStreamClient } from "@/components/epic-canvas/pr/__tests__/pr-stream-test-fixtures";
import {
  __resetBotListChangedSessionsForTesting,
  useBotListChangedSubscription,
} from "@/hooks/bots/use-bot-list-changed-subscription";

const HOST_A = "host-a";
const HOST_B = "host-b";
const CHANGED: StreamFrameEnvelope = {
  kind: "changed",
  hasBinaryPayload: false,
};

/**
 * A client whose answer to "does the host serve `bot.listChanged`?" the test
 * sets, and whose listeners hear every change - what `useSyncExternalStore`
 * in the real hook rides.
 */
class SupportClient extends MockWsStreamClient<StreamFrameEnvelope> {
  private currentSupport: StreamMethodSupport;
  private readonly supportListeners = new Set<() => void>();

  constructor(support: StreamMethodSupport) {
    super();
    this.currentSupport = support;
  }

  override getMethodSupport(): StreamMethodSupport {
    return this.currentSupport;
  }

  override subscribeMethodSupport(listener: () => void): () => void {
    this.supportListeners.add(listener);
    return () => {
      this.supportListeners.delete(listener);
    };
  }

  setSupport(next: StreamMethodSupport): void {
    this.currentSupport = next;
    for (const listener of Array.from(this.supportListeners)) listener();
  }
}

type Harness = {
  readonly queryClient: QueryClient;
  readonly invalidations: MockInstance<QueryClient["invalidateQueries"]>;
  readonly wrapper: (props: { children: ReactNode }) => ReactNode;
};

type HookProps = {
  readonly hostId: string | null;
  readonly client: SupportClient | null;
  readonly enabled: boolean;
};

const queryClients: QueryClient[] = [];
const unsubscribers: Array<() => void> = [];

afterEach(() => {
  cleanup();
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  for (const queryClient of queryClients.splice(0)) queryClient.clear();
  __resetBotListChangedSessionsForTesting();
});

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

function createHarness(): Harness {
  const queryClient = new QueryClient();
  queryClients.push(queryClient);
  seedBotList(queryClient, HOST_A);
  seedBotList(queryClient, HOST_B);
  const invalidations = vi.spyOn(queryClient, "invalidateQueries");
  return {
    queryClient,
    invalidations,
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  };
}

/** One surface asking for the doorbell. */
function mountSurface(harness: Harness, props: HookProps) {
  return renderHook(
    (current: HookProps) =>
      useBotListChangedSubscription(
        current.hostId,
        current.client,
        current.enabled,
      ),
    { wrapper: harness.wrapper, initialProps: props },
  );
}

function surface(client: SupportClient | null): HookProps {
  return { hostId: HOST_A, client, enabled: true };
}

function sessionOf(client: SupportClient) {
  const session = client.getSession("bot.listChanged", {});
  if (session === undefined) throw new Error("bot.listChanged not subscribed");
  return session;
}

function fatalClose(retryable: boolean): StreamCloseReason {
  return {
    kind: "fatalError",
    details: {
      code: "HOST_RESTARTING",
      reason: "test close",
      incompatibleMethods: null,
      upgradeGuidance: null,
      retryable,
    },
  };
}

describe("useBotListChangedSubscription frames", () => {
  it("invalidates bot.list on every host scope when a changed frame arrives", () => {
    const harness = createHarness();
    const client = new SupportClient("supported");
    mountSurface(harness, surface(client));

    sessionOf(client).emitFrame(CHANGED);

    expect(isInvalidated(harness.queryClient, HOST_A)).toBe(true);
    expect(isInvalidated(harness.queryClient, HOST_B)).toBe(true);
    expect(harness.invalidations).toHaveBeenCalledTimes(1);
  });

  it.each<readonly [string, StreamFrameEnvelope]>([
    ["a pong", { kind: "pong", hasBinaryPayload: false }],
    [
      "a frame that does not parse",
      { kind: "changed", hasBinaryPayload: true },
    ],
  ])("leaves bot.list alone on %s", (_name, frame) => {
    const harness = createHarness();
    const client = new SupportClient("supported");
    mountSurface(harness, surface(client));

    sessionOf(client).emitFrame(frame);

    expect(isInvalidated(harness.queryClient, HOST_A)).toBe(false);
    expect(isInvalidated(harness.queryClient, HOST_B)).toBe(false);
    expect(harness.invalidations).not.toHaveBeenCalled();
  });
});

describe("useBotListChangedSubscription reconnect", () => {
  it("makes one fetch per reconnect: the host's reconciliation changed, nothing of its own on open", async () => {
    const harness = createHarness();
    const client = new SupportClient("supported");
    mountSurface(harness, surface(client));
    const session = sessionOf(client);
    session.emitStatus("open", null);

    let fetches = 0;
    let aborted = 0;
    const observer = new QueryObserver(harness.queryClient, {
      queryKey: botListKey(HOST_A),
      queryFn: async ({ signal }) => {
        fetches += 1;
        signal.addEventListener("abort", () => {
          aborted += 1;
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { bots: [] };
      },
    });
    unsubscribers.push(observer.subscribe(() => undefined));
    await vi.waitFor(() => {
      expect(fetches).toBe(1);
      expect(observer.getCurrentResult().isFetching).toBe(false);
    });
    fetches = 0;
    aborted = 0;

    // The transport redials; the host's new subscription reconciles once its
    // rooms have opened.
    session.emitStatus("reconnecting", null);
    session.emitStatus("open", null);
    session.emitFrame(CHANGED);
    await vi.waitFor(() => {
      expect(observer.getCurrentResult().isFetching).toBe(false);
    });

    expect(fetches).toBe(1);
    expect(aborted).toBe(0);
  });
});

describe("useBotListChangedSubscription support", () => {
  it("holds the session through the client's transient unknown, and still delivers after it reopens", () => {
    const harness = createHarness();
    const client = new SupportClient("supported");
    mountSurface(harness, surface(client));
    const session = sessionOf(client);
    const close = vi.spyOn(session, "close");
    session.emitStatus("open", null);

    act(() => client.setSupport("unknown"));
    expect(client.subscribeCallCount).toBe(1);
    expect(close).not.toHaveBeenCalled();

    session.emitStatus("reconnecting", null);
    session.emitStatus("open", null);

    act(() => client.setSupport("supported"));
    expect(client.subscribeCallCount).toBe(1);
    expect(close).not.toHaveBeenCalled();

    session.emitFrame(CHANGED);
    expect(harness.invalidations).toHaveBeenCalledTimes(1);
  });

  it("closes the session when the host stops serving the method", () => {
    const harness = createHarness();
    const client = new SupportClient("supported");
    mountSurface(harness, surface(client));
    const close = vi.spyOn(sessionOf(client), "close");

    act(() => client.setSupport("unsupported"));

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("subscribes nothing until the client reports supported", () => {
    const harness = createHarness();
    const client = new SupportClient("unknown");
    mountSurface(harness, surface(client));
    expect(client.subscribeCallCount).toBe(0);

    act(() => client.setSupport("supported"));

    expect(client.subscribeCallCount).toBe(1);
  });
});

describe("useBotListChangedSubscription gating", () => {
  it.each<StreamMethodSupport>(["unsupported"])(
    "subscribes nothing on a client that has only ever been %s",
    (support) => {
      const harness = createHarness();
      const client = new SupportClient(support);
      mountSurface(harness, surface(client));

      expect(client.subscribeCallCount).toBe(0);
    },
  );

  it("subscribes nothing while disabled, and closes when disabled after", () => {
    const harness = createHarness();
    const client = new SupportClient("supported");
    const view = mountSurface(harness, { ...surface(client), enabled: false });
    expect(client.subscribeCallCount).toBe(0);

    view.rerender(surface(client));
    expect(client.subscribeCallCount).toBe(1);
    const close = vi.spyOn(sessionOf(client), "close");

    view.rerender({ ...surface(client), enabled: false });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does nothing, and does not throw, without a client", () => {
    const harness = createHarness();

    expect(() => mountSurface(harness, surface(null))).not.toThrow();
  });

  it("subscribes nothing without a host", () => {
    const harness = createHarness();
    const client = new SupportClient("supported");
    mountSurface(harness, { hostId: null, client, enabled: true });

    expect(client.subscribeCallCount).toBe(0);
  });
});

describe("useBotListChangedSubscription shared session", () => {
  it("opens one subscription for two surfaces on two clients, so one change is one refetch", async () => {
    const harness = createHarness();
    const homeClient = new SupportClient("supported");
    const tabClient = new SupportClient("supported");
    mountSurface(harness, surface(homeClient));
    mountSurface(harness, surface(tabClient));

    let fetches = 0;
    let aborted = 0;
    const observer = new QueryObserver(harness.queryClient, {
      queryKey: botListKey(HOST_A),
      queryFn: async ({ signal }) => {
        fetches += 1;
        signal.addEventListener("abort", () => {
          aborted += 1;
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { bots: [] };
      },
    });
    unsubscribers.push(observer.subscribe(() => undefined));
    await vi.waitFor(() => {
      expect(fetches).toBe(1);
      expect(observer.getCurrentResult().isFetching).toBe(false);
    });
    fetches = 0;
    aborted = 0;

    // A host change reaches every live subscription; deliver it to each.
    for (const client of [homeClient, tabClient]) {
      client.getSession("bot.listChanged", {})?.emitFrame(CHANGED);
    }
    await vi.waitFor(() => {
      expect(observer.getCurrentResult().isFetching).toBe(false);
    });

    expect(fetches).toBe(1);
    expect(aborted).toBe(0);
    expect(homeClient.subscribeCallCount + tabClient.subscribeCallCount).toBe(
      1,
    );
  });

  it("moves the subscription to the remaining surface's client when the carrying one leaves", () => {
    const harness = createHarness();
    const homeClient = new SupportClient("supported");
    const tabClient = new SupportClient("supported");
    const home = mountSurface(harness, surface(homeClient));
    const tab = mountSurface(harness, surface(tabClient));
    const homeClose = vi.spyOn(sessionOf(homeClient), "close");
    expect(tabClient.subscribeCallCount).toBe(0);

    home.unmount();

    expect(homeClose).toHaveBeenCalledTimes(1);
    expect(tabClient.subscribeCallCount).toBe(1);
    const tabSession = sessionOf(tabClient);
    const tabClose = vi.spyOn(tabSession, "close");
    tabSession.emitFrame(CHANGED);
    expect(isInvalidated(harness.queryClient, HOST_A)).toBe(true);

    tab.unmount();

    expect(tabClose).toHaveBeenCalledTimes(1);
    seedBotList(harness.queryClient, HOST_A);
    tabSession.emitFrame(CHANGED);
    expect(isInvalidated(harness.queryClient, HOST_A)).toBe(false);
  });

  it("hands the session to the remaining surface when the carrying client's owner closes it before this hook's cleanup", () => {
    const harness = createHarness();
    const homeClient = new SupportClient("supported");
    const tabClient = new SupportClient("supported");
    const home = mountSurface(harness, surface(homeClient));
    mountSurface(harness, surface(tabClient));
    expect(tabClient.subscribeCallCount).toBe(0);

    // A released lease closes the client, and every session on it, at once.
    homeClient.close("lease released");
    sessionOf(homeClient).close();
    home.unmount();

    expect(tabClient.subscribeCallCount).toBe(1);
    sessionOf(tabClient).emitFrame(CHANGED);
    expect(isInvalidated(harness.queryClient, HOST_A)).toBe(true);
  });

  it("keeps a fixed-host tab served when the app's host changes and its old client closes first", () => {
    const harness = createHarness();
    const appClientA = new SupportClient("supported");
    const tabClient = new SupportClient("supported");
    const home = mountSurface(harness, surface(appClientA));
    mountSurface(harness, surface(tabClient));

    // The app moves to host B: its old client closes before Home re-renders.
    appClientA.close("app host changed");
    sessionOf(appClientA).close();
    const appClientB = new SupportClient("supported");
    home.rerender({ hostId: HOST_B, client: appClientB, enabled: true });

    expect(tabClient.subscribeCallCount).toBe(1);
    expect(appClientB.subscribeCallCount).toBe(1);
    sessionOf(tabClient).emitFrame(CHANGED);
    expect(isInvalidated(harness.queryClient, HOST_A)).toBe(true);
  });

  it("hands the session on at a terminal close while every surface stays mounted, and never back to a client that failed", () => {
    const harness = createHarness();
    const homeClient = new SupportClient("supported");
    const tabClient = new SupportClient("supported");
    mountSurface(harness, surface(homeClient));
    mountSurface(harness, surface(tabClient));

    sessionOf(homeClient).emitStatus("closed", fatalClose(false));

    expect(tabClient.subscribeCallCount).toBe(1);
    sessionOf(tabClient).emitFrame(CHANGED);
    expect(isInvalidated(harness.queryClient, HOST_A)).toBe(true);

    sessionOf(tabClient).emitStatus("closed", fatalClose(false));

    expect(homeClient.subscribeCallCount).toBe(1);
    expect(tabClient.subscribeCallCount).toBe(1);
  });

  it("keeps the subscription when a surface that does not carry it leaves", () => {
    const harness = createHarness();
    const homeClient = new SupportClient("supported");
    const tabClient = new SupportClient("supported");
    mountSurface(harness, surface(homeClient));
    const tab = mountSurface(harness, surface(tabClient));
    const homeSession = sessionOf(homeClient);
    const homeClose = vi.spyOn(homeSession, "close");

    tab.unmount();

    expect(homeClose).not.toHaveBeenCalled();
    expect(tabClient.subscribeCallCount).toBe(0);
    homeSession.emitFrame(CHANGED);
    expect(isInvalidated(harness.queryClient, HOST_A)).toBe(true);
  });
});

describe("useBotListChangedSubscription close", () => {
  it("keeps the session through a retryable close, which the transport redials", () => {
    const harness = createHarness();
    const client = new SupportClient("supported");
    const other = new SupportClient("supported");
    mountSurface(harness, surface(client));
    const session = sessionOf(client);

    session.emitStatus("closed", fatalClose(true));
    session.emitFrame(CHANGED);

    expect(isInvalidated(harness.queryClient, HOST_A)).toBe(true);
    mountSurface(harness, surface(other));
    expect(other.subscribeCallCount).toBe(0);
  });

  it("ends the session on a non-retryable close, and the next surface to join opens a fresh one", () => {
    const harness = createHarness();
    const client = new SupportClient("supported");
    const next = new SupportClient("supported");
    mountSurface(harness, surface(client));

    sessionOf(client).emitStatus("closed", fatalClose(false));
    sessionOf(client).emitFrame(CHANGED);
    expect(harness.invalidations).not.toHaveBeenCalled();

    mountSurface(harness, surface(next));
    expect(next.subscribeCallCount).toBe(1);
    sessionOf(next).emitFrame(CHANGED);
    expect(isInvalidated(harness.queryClient, HOST_A)).toBe(true);
  });
});
