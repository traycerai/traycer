import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type {
  PrSourceNotice,
  PrSubscribeDetailServerFrame,
} from "@traycer/protocol/host/pr-schemas";
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
 * `useHostStreamClientFor`, NEVER from `useAddressableHostId()` /
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
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";

/**
 * Mock stream session for `pr.subscribeDetail`. Frame fields ride directly
 * on the envelope (no `.value` wrapping), same convention as the sibling
 * list-hook mock in `use-pr-list-subscription.test.tsx`.
 */
class MockStreamSession implements IStreamSession {
  private serverFrameHandler: ServerFrameHandler | null = null;
  private statusChangeHandler: StatusChangeHandler | null = null;
  closed: boolean = false;
  sentClientFrames: StreamFrameEnvelope[] = [];

  onServerFrame(handler: ServerFrameHandler): void {
    this.serverFrameHandler = handler;
  }

  onStatusChange(handler: StatusChangeHandler): void {
    this.statusChangeHandler = handler;
  }

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

function buildDetailFrame(
  kind: "snapshot" | "updated",
  notice: PrSourceNotice | null,
): PrSubscribeDetailServerFrame {
  return {
    kind,
    hasBinaryPayload: false,
    sourceStatus: "cached",
    notice,
    liveness: "live",
    core: {
      observedAt: 1_000,
      githubHost: "github.com",
      base: { owner: "acme", repo: "widgets", prNumber: 7 },
      prUrl: "https://github.com/acme/widgets/pull/7",
      state: "open",
      isDraft: false,
      title: "Add feature X",
      body: "Some description",
      author: { login: "octocat", avatarUrl: null },
      baseRefName: "main",
      headRefName: "feature/x",
      headRefOid: "abc123",
      additions: 10,
      deletions: 2,
      checksRollup: null,
      reviewDecision: null,
      reviewRequests: [],
      commentCount: 0,
      updatedAt: 1_000,
      mergedAt: null,
      repoIdentifier: { owner: "acme", repo: "widgets" },
      repoRole: "superproject",
      linkGroupKey: null,
      owners: [],
    },
    checks: { observedAt: 1_000, contexts: [], isTruncated: false },
    activity: { observedAt: 1_000, items: [], isTruncated: false },
    reviewThreads: { observedAt: 1_000, threads: [], isTruncated: false },
    files: {
      observedAt: 1_000,
      files: [],
      totalCount: null,
      isTruncated: false,
    },
    commits: {
      observedAt: 1_000,
      commits: [],
      totalCount: null,
      isTruncated: false,
    },
  };
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
    // `useAddressableHostId` (or any comparable) input to compare
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

  it("preserves a second, non-retrying consumer's ref count when the first consumer retries a terminal session", async () => {
    tabHostIdRef.value = "host4";
    const args = {
      epicId: "epic-3",
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 7,
      enabled: true,
    };

    const consumerA = renderHook(() => usePrDetailSubscription(args), {
      wrapper: createWrapper(),
    });
    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });

    // A second consumer for the SAME PR/epic shares A's session - no new
    // `subscribe` call.
    const consumerB = renderHook(() => usePrDetailSubscription(args), {
      wrapper: createWrapper(),
    });
    expect(mockWsStreamClient.subscribeCallCount).toBe(1);

    const firstSession = mockWsStreamClient.getSession("pr.subscribeDetail", {
      epicId: "epic-3",
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 7,
    });
    expect(firstSession).toBeDefined();
    if (firstSession === undefined) return;
    // The mock keys sessions by (method, params), so a retry's `subscribe`
    // call for the SAME params returns this SAME object - `close` call
    // counts are how this test observes distinct teardown lifecycles despite
    // that.
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
    // A's unmount must NOT close the transport.
    act(() => {
      consumerA.unmount();
    });
    expect(closeSpy).not.toHaveBeenCalled();

    // The last remaining consumer (B) unmounting tears the fresh session
    // down.
    act(() => {
      consumerB.unmount();
    });
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("sends an actual refresh frame (not a reconnect) after a nonfatal error, since the session is still live", async () => {
    tabHostIdRef.value = "host5";
    const args = {
      epicId: "epic-4",
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 8,
      enabled: true,
    };

    const { result } = renderHook(() => usePrDetailSubscription(args), {
      wrapper: createWrapper(),
    });
    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });

    const session = mockWsStreamClient.getSession("pr.subscribeDetail", {
      epicId: "epic-4",
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 8,
    });
    expect(session).toBeDefined();
    if (session === undefined) return;

    // A NONFATAL error frame leaves the session live (`isTerminal` stays
    // false) - only its `lastEvent` becomes an error.
    act(() => {
      session.emitFrame({
        kind: "error",
        hasBinaryPayload: false,
        message: "transient hiccup",
        isFatal: false,
      });
    });
    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });
    expect(session.closed).toBe(false);

    act(() => {
      result.current.sendRefresh();
    });

    // A reconnect (`retry()`) would bump `subscribeCallCount`; a refresh
    // frame on the still-live session must not.
    expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    expect(session.sentClientFrames).toEqual([
      { kind: "refresh", hasBinaryPayload: false },
    ]);
  });

  it("carries the fetch-layer notice from a snapshot frame into the cache, and keeps it fresh across an updated frame that clears it", async () => {
    tabHostIdRef.value = "host6";
    const args = {
      epicId: "epic-5",
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 9,
      enabled: true,
    };

    const { result, rerender } = renderHook(
      () => usePrDetailSubscription(args),
      { wrapper: createWrapper() },
    );
    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });
    const session = mockWsStreamClient.getSession("pr.subscribeDetail", {
      epicId: "epic-5",
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 9,
    });
    expect(session).toBeDefined();
    if (session === undefined) return;

    // Hydration snapshot arrives while the host is already paused - the
    // notice must reach the cache on the FIRST frame.
    act(() => {
      session.emitFrame(
        buildDetailFrame("snapshot", { kind: "rate-limited", retryAt: 1_000 }),
      );
    });
    await waitFor(() => {
      expect(result.current.data?.notice).toEqual({
        kind: "rate-limited",
        retryAt: 1_000,
      });
    });

    // A later `updated` frame that resumed fetching clears the notice - a
    // re-render must not resurrect the stale value from a stale closure.
    act(() => {
      session.emitFrame(buildDetailFrame("updated", null));
    });
    await waitFor(() => {
      expect(result.current.data?.notice).toBeNull();
    });

    rerender();
    expect(result.current.data?.notice).toBeNull();
  });

  it("replays the last frame's notice into the cache for a second consumer joining an already-live session", async () => {
    tabHostIdRef.value = "host7";
    const args = {
      epicId: "epic-6",
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 10,
      enabled: true,
    };

    const consumerA = renderHook(() => usePrDetailSubscription(args), {
      wrapper: createWrapper(),
    });
    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });
    const session = mockWsStreamClient.getSession("pr.subscribeDetail", {
      epicId: "epic-6",
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
      prNumber: 10,
    });
    expect(session).toBeDefined();
    if (session === undefined) return;

    act(() => {
      session.emitFrame(
        buildDetailFrame("snapshot", { kind: "backing-off", retryAt: null }),
      );
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

    const consumerB = renderHook(() => usePrDetailSubscription(args), {
      wrapper: createWrapper(),
    });
    await waitFor(() => {
      expect(consumerB.result.current.data?.notice).toEqual({
        kind: "backing-off",
        retryAt: null,
      });
    });
  });
});
