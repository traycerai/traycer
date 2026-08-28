import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { PrSubscribeListForEpicServerFrame } from "@traycer/protocol/host/pr-schemas";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamFrameEnvelope,
  StreamCloseReason,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import {
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import {
  WsStreamClient,
  type ParamsOf,
} from "@traycer-clients/shared/host-transport/ws-stream-client";
import { StreamRuntimeContext } from "@/lib/host/stream-runtime-context";
import {
  usePrListSubscription,
  __resetPrListSubscriptionsForTesting,
} from "../use-pr-list-subscription";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";

/**
 * Mock stream session for `pr.subscribeListForEpic`. Unlike git's status
 * stream, the PR list stream's frame fields ride directly on the envelope
 * (`prSubscribeListForEpicServerFrameSchema` is NOT nested under
 * `envelope.value`), so `emitFrame` spreads the frame straight onto the
 * envelope instead of wrapping it.
 */
class MockStreamSession implements IStreamSession {
  private serverFrameHandler: ServerFrameHandler | null = null;
  private statusChangeHandler: StatusChangeHandler | null = null;
  closed: boolean = false;

  onServerFrame(handler: ServerFrameHandler): void {
    this.serverFrameHandler = handler;
  }

  onStatusChange(handler: StatusChangeHandler): void {
    this.statusChangeHandler = handler;
  }

  // Captured rather than dropped: a refresh is only observable as a SENT
  // client frame, so without this a test cannot tell "sent a refresh" apart
  // from "silently did nothing".
  sentClientFrames: StreamFrameEnvelope[] = [];

  sendClientFrame(
    envelope: StreamFrameEnvelope,
    _binaryPayload: Uint8Array | null,
  ): void {
    this.sentClientFrames.push(envelope);
  }

  /** Never negotiates: this fake exercises no version-dependent path. */
  getNegotiatedSchemaVersion(): SchemaVersion | null {
    return null;
  }

  requestReconnect(): void {
    // No-op for this test; reconnect is owned by the real StreamSession.
  }

  close(): void {
    this.closed = true;
    this.statusChangeHandler?.("closed", { kind: "caller" });
  }

  emitFrame(frame: PrSubscribeListForEpicServerFrame): void {
    if (this.serverFrameHandler !== null) {
      const handler = this.serverFrameHandler;
      const envelope = { ...frame } satisfies StreamFrameEnvelope;
      handler(envelope, null);
    }
  }

  emitStatus(
    status: "connecting" | "open" | "reconnecting" | "closed",
    reason: StreamCloseReason | null,
  ): void {
    this.statusChangeHandler?.(status, reason);
  }
}

class MockWsStreamClient extends WsStreamClient<HostStreamRpcRegistry> {
  sessions: Map<string, MockStreamSession> = new Map();
  subscribeCallCount: number = 0;

  constructor() {
    super({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: () => null,
      bearer: () => null,
      auth: null,
      hostCredentialMint: null,
      onHostCredentialState: null,
      evidence: NO_TRANSPORT_EVIDENCE,
      webSocketFactory: {
        create: () => {
          throw new Error("MockWsStreamClient should not open a websocket");
        },
      },
      dialTimeoutMs: 1_000,
      openAckTimeoutMs: 1_000,
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });
  }

  override subscribe<Method extends keyof HostStreamRpcRegistry & string>(
    method: Method,
    params: ParamsOf<HostStreamRpcRegistry, Method>,
  ): IStreamSession {
    this.subscribeCallCount += 1;
    const key = JSON.stringify({ method, params });

    if (!this.sessions.has(key)) {
      this.sessions.set(key, new MockStreamSession());
    }

    const session = this.sessions.get(key);
    if (session === undefined) {
      throw new Error("Session not found");
    }
    return session;
  }

  getSession(method: string, params: unknown): MockStreamSession | undefined {
    const key = JSON.stringify({ method, params });
    return this.sessions.get(key);
  }
}

describe("usePrListSubscription", () => {
  let queryClient: QueryClient;
  let mockWsStreamClient: MockWsStreamClient;

  const createWrapper = () => {
    return ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <StreamRuntimeContext.Provider
          value={{ wsStreamClient: mockWsStreamClient, hostId: null }}
        >
          {children}
        </StreamRuntimeContext.Provider>
      </QueryClientProvider>
    );
  };

  beforeEach(() => {
    __resetPrListSubscriptionsForTesting();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockWsStreamClient = new MockWsStreamClient();
  });

  afterEach(() => {
    __resetPrListSubscriptionsForTesting();
    queryClient.clear();
  });

  it("background and foreground subscribers for the same host+epic open two independent sessions, and unmounting one leaves the other open", async () => {
    const { unmount: unmountBackground } = renderHook(
      () =>
        usePrListSubscription({
          hostId: "host1",
          epicId: "epic1",
          mode: "background",
          enabled: true,
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });
    const backgroundSession = mockWsStreamClient.getSession(
      "pr.subscribeListForEpic",
      { epicId: "epic1", mode: "background" },
    );
    expect(backgroundSession).toBeDefined();
    if (backgroundSession === undefined) return;
    expect(backgroundSession.closed).toBe(false);

    // A foreground subscriber for the SAME host+epic mounts too - the module
    // keys shared subscriptions by (client, hostId, epicId, mode), so this
    // must open a SECOND, independent session rather than reusing/collapsing
    // into the background one.
    const { unmount: unmountForeground } = renderHook(
      () =>
        usePrListSubscription({
          hostId: "host1",
          epicId: "epic1",
          mode: "foreground",
          enabled: true,
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(2);
    });
    const foregroundSession = mockWsStreamClient.getSession(
      "pr.subscribeListForEpic",
      { epicId: "epic1", mode: "foreground" },
    );
    expect(foregroundSession).toBeDefined();
    if (foregroundSession === undefined) return;

    expect(foregroundSession).not.toBe(backgroundSession);
    expect(backgroundSession.closed).toBe(false);
    expect(foregroundSession.closed).toBe(false);

    // Unmounting the foreground subscriber tears down ONLY its own session -
    // the background session (still ref-counted by its own mounted consumer)
    // must not collapse.
    unmountForeground();
    expect(foregroundSession.closed).toBe(true);
    expect(backgroundSession.closed).toBe(false);

    // Unmounting the last (background) subscriber tears its session down too.
    unmountBackground();
    expect(backgroundSession.closed).toBe(true);
  });

  it("sends a real refresh frame after a NONFATAL error instead of reconnecting", async () => {
    // A nonfatal error frame leaves the session live (`isTerminal` stays
    // false), so a refresh must go out as an actual client frame. Branching
    // on the error's mere presence would call `retry()`, which only bumps the
    // nonce - the effect then reuses this same non-terminal session and sends
    // nothing, silently swallowing the user's refresh.
    const { result } = renderHook(
      () =>
        usePrListSubscription({
          hostId: "host1",
          epicId: "epic1",
          mode: "foreground",
          enabled: true,
        }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });

    const session = mockWsStreamClient.getSession("pr.subscribeListForEpic", {
      epicId: "epic1",
      mode: "foreground",
    });
    expect(session).toBeDefined();
    if (session === undefined) return;

    act(() => {
      session.emitFrame({
        kind: "error",
        hasBinaryPayload: false,
        isFatal: false,
        message: "one sweep failed",
      });
    });
    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    const framesBefore = session.sentClientFrames.length;
    const subscribesBefore = mockWsStreamClient.subscribeCallCount;
    act(() => {
      result.current.sendRefresh();
    });

    // A frame went out on the SAME live session - not a reconnect.
    expect(session.sentClientFrames.length).toBe(framesBefore + 1);
    expect(mockWsStreamClient.subscribeCallCount).toBe(subscribesBefore);
  });

  it("preserves a second, non-retrying consumer's ref count when the first consumer retries a terminal session", async () => {
    const consumerA = renderHook(
      () =>
        usePrListSubscription({
          hostId: "host1",
          epicId: "epic1",
          mode: "foreground",
          enabled: true,
        }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });

    // A second consumer for the SAME (host, epic, mode) shares A's session -
    // no new `subscribe` call.
    const consumerB = renderHook(
      () =>
        usePrListSubscription({
          hostId: "host1",
          epicId: "epic1",
          mode: "foreground",
          enabled: true,
        }),
      { wrapper: createWrapper() },
    );
    expect(mockWsStreamClient.subscribeCallCount).toBe(1);

    const firstSession = mockWsStreamClient.getSession(
      "pr.subscribeListForEpic",
      { epicId: "epic1", mode: "foreground" },
    );
    expect(firstSession).toBeDefined();
    if (firstSession === undefined) return;
    // The mock keys sessions by (method, params), so a retry's `subscribe`
    // call for the SAME params returns this SAME object - `close` call counts
    // are how this test observes distinct teardown lifecycles despite that.
    const closeSpy = vi.spyOn(firstSession, "close");

    // A fatal transport close marks the shared session terminal - both
    // consumers observe the error.
    act(() => {
      firstSession.emitStatus("closed", { kind: "caller" });
    });
    await waitFor(() => {
      expect(consumerA.result.current.error).not.toBeNull();
    });
    expect(consumerB.result.current.error).not.toBeNull();

    // Consumer A retries: a fresh session replaces the terminal entry.
    act(() => {
      consumerA.result.current.sendRefresh();
    });
    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(2);
    });
    closeSpy.mockClear();

    // Consumer A (the retrying one) unmounts. Consumer B never retried and is
    // still mounted - migration must have moved B onto the FRESH session, so
    // A's unmount (fresh refCount 2 -> 1) must NOT close the transport.
    act(() => {
      consumerA.unmount();
    });
    expect(closeSpy).not.toHaveBeenCalled();

    // The last remaining consumer (B) unmounting tears the fresh session down.
    act(() => {
      consumerB.unmount();
    });
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("flipping enabled from true to false tears down the underlying session (renderer-side proof that a whole-sidebar collapse unsubscribes)", async () => {
    const { rerender } = renderHook(
      (props: { enabled: boolean }) =>
        usePrListSubscription({
          hostId: "host1",
          epicId: "epic1",
          mode: "foreground",
          enabled: props.enabled,
        }),
      { wrapper: createWrapper(), initialProps: { enabled: true } },
    );

    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });
    const session = mockWsStreamClient.getSession("pr.subscribeListForEpic", {
      epicId: "epic1",
      mode: "foreground",
    });
    expect(session).toBeDefined();
    if (session === undefined) return;
    expect(session.closed).toBe(false);

    // The body stays mounted through a CSS-only sidebar collapse - only
    // `enabled` flips. The hook's own effect cleanup (ref count -> 0) must be
    // what tears the transport down, since mount-gating alone doesn't apply.
    rerender({ enabled: false });

    await waitFor(() => {
      expect(session.closed).toBe(true);
    });
  });

  it("carries the fetch-layer notice from a snapshot frame into the cache, and keeps it across an updated frame that clears it", async () => {
    const { result, rerender } = renderHook(
      () =>
        usePrListSubscription({
          hostId: "host1",
          epicId: "epic1",
          mode: "foreground",
          enabled: true,
        }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });
    const session = mockWsStreamClient.getSession("pr.subscribeListForEpic", {
      epicId: "epic1",
      mode: "foreground",
    });
    expect(session).toBeDefined();
    if (session === undefined) return;

    // Hydration snapshot arrives while the host is already paused - the
    // notice must reach the cache on the FIRST frame, not just later updates.
    act(() => {
      session.emitFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        sourceStatus: "cached",
        notice: { kind: "rate-limited", retryAt: 1_000 },
        items: [],
      });
    });
    await waitFor(() => {
      expect(result.current.data?.notice).toEqual({
        kind: "rate-limited",
        retryAt: 1_000,
      });
    });

    // A later `updated` frame that resumed fetching clears the notice - a
    // re-render (forced here via `rerender`) must not resurrect the stale
    // value from a stale closure.
    act(() => {
      session.emitFrame({
        kind: "updated",
        hasBinaryPayload: false,
        sourceStatus: "ok",
        notice: null,
        items: [],
      });
    });
    await waitFor(() => {
      expect(result.current.data?.notice).toBeNull();
    });

    rerender();
    expect(result.current.data?.notice).toBeNull();
  });

  it("replays the last frame's notice into the cache for a second consumer joining an already-live session", async () => {
    const consumerA = renderHook(
      () =>
        usePrListSubscription({
          hostId: "host1",
          epicId: "epic1",
          mode: "foreground",
          enabled: true,
        }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });
    const session = mockWsStreamClient.getSession("pr.subscribeListForEpic", {
      epicId: "epic1",
      mode: "foreground",
    });
    expect(session).toBeDefined();
    if (session === undefined) return;

    act(() => {
      session.emitFrame({
        kind: "snapshot",
        hasBinaryPayload: false,
        sourceStatus: "cached",
        notice: { kind: "backing-off", retryAt: null },
        items: [],
      });
    });
    await waitFor(() => {
      expect(consumerA.result.current.data?.notice).toEqual({
        kind: "backing-off",
        retryAt: null,
      });
    });

    // GC the query cache slot to simulate it being unobserved before B joins.
    act(() => {
      queryClient.removeQueries();
    });

    const consumerB = renderHook(
      () =>
        usePrListSubscription({
          hostId: "host1",
          epicId: "epic1",
          mode: "foreground",
          enabled: true,
        }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => {
      expect(consumerB.result.current.data?.notice).toEqual({
        kind: "backing-off",
        retryAt: null,
      });
    });
  });
});
