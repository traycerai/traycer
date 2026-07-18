import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
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

  sendClientFrame(
    _envelope: StreamFrameEnvelope,
    _binaryPayload: Uint8Array | null,
  ): void {
    // No-op for this test.
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
      registry: hostStreamRpcRegistry,
      endpoint: () => null,
      bearer: () => null,
      auth: null,
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
          value={{ wsStreamClient: mockWsStreamClient }}
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
});
