import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { PrSubscribeDetailServerFrame } from "@traycer/protocol/host/pr-schemas";
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

/**
 * Test (a) - non-default-host subscription.
 *
 * `usePrDetailSubscription` resolves its transport from `useTabHostId()` ->
 * `useHostStreamClientFor`, NEVER from `useReactiveActiveHostId()` /
 * `StreamRuntimeContext` (the app-wide default-host client) - unlike
 * `GitDiffTile`, which gates on `tabHostId === activeHostId`. This file
 * mocks `useTabHostId` directly (no `<TabHostProvider>` needed for a
 * `renderHook`-only test) and mocks `useHostStreamClientFor` to hand back a
 * fake `WsStreamClient` unconditionally - there is no "active host" mock
 * anywhere in this file, which is itself part of the proof: the hook has no
 * code path that could even read one.
 *
 * `usePrDetailSubscription` also calls `useHostDirectoryEntry` and
 * `useStreamAuthRevalidator` directly (not just `useHostStreamClientFor`
 * internally) - both read `@/lib/host`'s `useHostDirectory` /
 * `useAuthService`, which need a `HostRuntimeContext` provider in
 * production. Mocking `@/lib/host` sidesteps that requirement, mirroring
 * `chat-tile.test.tsx`'s barrel-mock convention. Their return values are
 * discarded anyway since `useHostStreamClientFor` itself is mocked to
 * ignore its `target`/`auth` arguments.
 */

const tabHostIdRef = vi.hoisted(() => ({ value: "host1" }));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => tabHostIdRef.value,
}));

vi.mock("@/lib/host", () => ({
  useHostDirectory: () => ({
    onChange: () => ({ dispose() {} }),
    findById: () => null,
  }),
  useAuthService: () => ({
    revalidateCurrentContext: () => Promise.resolve({ kind: "valid" as const }),
  }),
}));

const wsStreamClientRef = vi.hoisted(() => ({
  value: null as WsStreamClient<HostStreamRpcRegistry> | null,
}));

vi.mock("@/hooks/host/use-host-stream-client-for", () => ({
  useHostStreamClientFor: () => wsStreamClientRef.value,
}));

import {
  usePrDetailSubscription,
  __resetPrDetailSubscriptionsForTesting,
} from "../use-pr-detail-subscription";

/**
 * Mock stream session for `pr.subscribeDetail`. Frame fields ride directly
 * on the envelope (no `.value` wrapping), same convention as the sibling
 * list-hook mock in `use-pr-list-subscription.test.tsx`.
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

  emitFrame(frame: PrSubscribeDetailServerFrame): void {
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

describe("usePrDetailSubscription - non-default-host subscription", () => {
  let queryClient: QueryClient;
  let mockWsStreamClient: MockWsStreamClient;

  const createWrapper = () => {
    return ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };

  beforeEach(() => {
    __resetPrDetailSubscriptionsForTesting();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockWsStreamClient = new MockWsStreamClient();
    wsStreamClientRef.value = mockWsStreamClient;
    tabHostIdRef.value = "host1";
  });

  afterEach(() => {
    __resetPrDetailSubscriptionsForTesting();
    queryClient.clear();
    wsStreamClientRef.value = null;
  });

  it("subscribes through whatever client useTabHostId resolves to, for a bound host that is NOT any app-wide 'active host', with exact open-request params, and tears down on unmount", async () => {
    // "host2" stands in for a tab bound to a host that differs from whatever
    // the app's default/active host happens to be. The hook has no
    // `useReactiveActiveHostId` (or any comparable) input to compare
    // against - this file never even imports/mocks that concept - so a
    // successful subscribe here is a direct proof of its absence.
    tabHostIdRef.value = "host2";

    const args = {
      epicId: "epic-1",
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 42,
      enabled: true,
    };

    const { unmount } = renderHook(() => usePrDetailSubscription(args), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });

    const session = mockWsStreamClient.getSession("pr.subscribeDetail", {
      epicId: "epic-1",
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 42,
    });
    expect(session).toBeDefined();
    if (session === undefined) return;
    expect(session.closed).toBe(false);

    // Ref-counted teardown: the sole consumer unmounting closes the session
    // immediately (ADR-0003 - no grace period).
    unmount();
    expect(session.closed).toBe(true);
    expect(mockWsStreamClient.subscribeCallCount).toBe(1);
  });

  it("succeeds identically for a second, different bound host (host3) - subscribe outcome does not depend on which host id useTabHostId returns", async () => {
    tabHostIdRef.value = "host3";

    const { unmount } = renderHook(
      () =>
        usePrDetailSubscription({
          epicId: "epic-2",
          githubHost: "github.com",
          owner: "acme",
          repo: "widgets",
          prNumber: 99,
          enabled: true,
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });

    const session = mockWsStreamClient.getSession("pr.subscribeDetail", {
      epicId: "epic-2",
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 99,
    });
    expect(session).toBeDefined();
    if (session === undefined) return;
    expect(session.closed).toBe(false);

    unmount();
    expect(session.closed).toBe(true);
  });
});
