import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  focusManager,
  QueryClientProvider,
  type QueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  act,
  cleanup,
  renderHook,
  waitFor,
  type RenderHookResult,
} from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { CloudChatIdentity } from "@traycer/protocol/host/epic/cloud-chat";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useCloudChatPayloadList } from "@/hooks/chats/use-cloud-chat-queries";

/**
 * What actually heals a SHORT payload list, pinned as request counts.
 *
 * The publisher commits a chat's head first and uploads its heavy content
 * afterwards, so a reader who opens a chat inside that window is answered
 * truthfully and short. `useCloudChatPayloadList`'s doc comment records the
 * decision NOT to close that window with a client-side poll, and states three
 * facts about what the surface does today instead. Those facts are the whole
 * basis of the decision, and none of them is asserted anywhere else - a poll
 * added by accident (or `staleTime` drifting off zero, which is what makes the
 * reopen refetch) would change the surface's behavior with nothing going red.
 *
 * The QueryClient here is `createAppQueryClient()` rather than a bare
 * `new QueryClient()` on purpose: two of the three facts are properties of the
 * app's own defaults (`refetchOnWindowFocus: false`,
 * `refetchOnReconnect: false`), and a test-local client would quietly assert
 * something the app does not do.
 */

const IDENTITY: CloudChatIdentity = {
  taskId: "task-1",
  chatId: "chat-1",
  ownerUserId: "owner-1",
};

/**
 * What one mount of the hook under test renders to. Spelled out rather than
 * read off the hook, so a change to its declared result type surfaces here as
 * a type error instead of being absorbed silently.
 */
type PayloadListRender = RenderHookResult<
  UseQueryResult<
    ResponseOfMethod<HostRpcRegistry, "epic.listCloudChatPayloads">,
    HostRpcError
  >,
  Record<never, never>
>;

/** Lowercase hex, 64 chars - the only form the wire accepts for an address. */
const PLAN_CONTENT_SHA256 = "b".repeat(64);

type Fixture = {
  readonly client: HostClient<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
  /** Every `epic.listCloudChatPayloads` that reached the messenger. */
  readonly requests: { value: number };
};

/**
 * A host whose FIRST answer is the racing short one and whose every later
 * answer is the converged list. Any heal is therefore visible twice over - as
 * a second request, and as refs the transcript can fetch.
 */
function createFixture(): Fixture {
  const requests = { value: 0 };
  const queryClient = createAppQueryClient();
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-payload-list-${String(requests.value)}`,
      handlers: {
        "epic.listCloudChatPayloads": () => {
          requests.value += 1;
          return Promise.resolve({
            outcome:
              requests.value === 1
                ? { status: "ok" as const, refs: [] }
                : {
                    status: "ok" as const,
                    refs: [
                      { kind: "plan-content", sha256: PLAN_CONTENT_SHA256 },
                    ],
                  },
          });
        },
      },
    }),
  });
  client.bind(mockLocalHostEntry);
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode =>
    createElement(QueryClientProvider, { client: queryClient }, props.children);
  return { client, queryClient, Wrapper, requests };
}

describe("useCloudChatPayloadList healing", () => {
  // Viewer-scoped by construction: the hook disables itself without a resolved
  // identity, so every test seeds one and the reset keeps them independent.
  beforeEach(() => {
    useAuthStore.setState({
      contextMetadata: { userId: "viewer-1", username: "viewer-1" },
    });
  });
  afterEach(() => {
    cleanup();
    focusManager.setFocused(undefined);
    useAuthStore.setState(useAuthStore.getInitialState(), true);
    vi.useRealTimers();
  });

  it("issues one request per mount and schedules nothing behind it", async () => {
    // Faked from BEFORE the render: an interval installed while the query was
    // settling would be armed on the real clock, and advancing a fake one
    // afterwards would step over it and read as a pass.
    vi.useFakeTimers();
    const fixture = createFixture();

    const rendered = renderHook(
      () =>
        useCloudChatPayloadList({
          client: fixture.client,
          identity: IDENTITY,
          enabled: true,
        }),
      { wrapper: fixture.Wrapper },
    );

    // Zero-advance flushes: the answer arrives on microtasks, so no time has
    // to pass for it - which is what lets the assertion below be about time.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (rendered.result.current.data !== undefined) break;
      await flushTimers(0);
    }
    expect(rendered.result.current.data?.outcome).toEqual({
      status: "ok",
      refs: [],
    });
    expect(fixture.requests.value).toBe(1);

    // Ten minutes is well past any cadence a "bounded" poll would plausibly
    // pick, and past the publisher's whole blob retry ladder.
    await flushTimers(10 * 60_000);

    expect(fixture.requests.value).toBe(1);
    expect(rendered.result.current.data?.outcome).toEqual({
      status: "ok",
      refs: [],
    });
  });

  it("heals on REOPEN - a fresh mount refetches and converges", async () => {
    const fixture = createFixture();
    const renderPayloadList = (): PayloadListRender =>
      renderHook(
        () =>
          useCloudChatPayloadList({
            client: fixture.client,
            identity: IDENTITY,
            enabled: true,
          }),
        { wrapper: fixture.Wrapper },
      );

    const opened = renderPayloadList();
    await waitFor(() => {
      expect(opened.result.current.data).toBeDefined();
    });
    expect(opened.result.current.data?.outcome).toEqual({
      status: "ok",
      refs: [],
    });
    opened.unmount();

    // The cache entry survives the close (gcTime is the app default here, not
    // the head read's instant eviction), so this proves the REFETCH rather
    // than a cache miss: `staleTime: 0` is what makes the served entry stale
    // on arrival and sends the new observer to the host.
    const reopened = renderPayloadList();
    await waitFor(() => {
      expect(reopened.result.current.data?.outcome).toEqual({
        status: "ok",
        refs: [{ kind: "plan-content", sha256: PLAN_CONTENT_SHA256 }],
      });
    });
    expect(fixture.requests.value).toBe(2);
  });

  it("does NOT heal on a window-focus event", async () => {
    const fixture = createFixture();

    const rendered = renderHook(
      () =>
        useCloudChatPayloadList({
          client: fixture.client,
          identity: IDENTITY,
          enabled: true,
        }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      expect(rendered.result.current.data).toBeDefined();
    });
    expect(fixture.requests.value).toBe(1);

    // Leaving the window and coming back is the heal the ticket assumed this
    // surface already had. The app's QueryClient turns it off globally and
    // this query does not opt back in, so the markers survive the round trip.
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await Promise.resolve();
    });

    expect(fixture.requests.value).toBe(1);
    expect(rendered.result.current.data?.outcome).toEqual({
      status: "ok",
      refs: [],
    });
  });

  it("never asks without an identity or while the caller has it disabled", async () => {
    const fixture = createFixture();

    const withoutIdentity = renderHook(
      () =>
        useCloudChatPayloadList({
          client: fixture.client,
          identity: null,
          enabled: true,
        }),
      { wrapper: fixture.Wrapper },
    );
    const disabled = renderHook(
      () =>
        useCloudChatPayloadList({
          client: fixture.client,
          identity: IDENTITY,
          enabled: false,
        }),
      { wrapper: fixture.Wrapper },
    );

    // A disabled query is exactly where an unguarded interval shows up, so the
    // wait here is deliberate rather than a formality.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fixture.requests.value).toBe(0);
    expect(withoutIdentity.result.current.isEnabled).toBe(false);
    expect(disabled.result.current.isEnabled).toBe(false);
  });
});

/** Advances fake timers inside `act` so React flushes what they produced. */
async function flushTimers(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
