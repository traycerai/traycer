import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type {
  GitListChangedFilesResponse,
  GitListChangedFilesResponseV11,
  GitSubscribeStatusEvent,
  GitSubscribeStatusEventV11,
  GitSubscribeStatusEventV12,
  GitSubscribeStatusEventV13,
  GitWatcherStatus,
} from "@traycer/protocol/host/git-schemas";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
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
import { DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET } from "@traycer/protocol/host";
import { StreamRuntimeContext } from "@/lib/host/stream-runtime-context";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import { __resetRichSlotOrderingForTesting } from "@/lib/git/git-rich-slot-ordering";
import {
  useGitListChangedFilesSubscription,
  refreshGitSubscriptionWithFreshNonce,
  useGitSubscriptionOwnsRichSlot,
  useGitSubscriptionRefreshState,
  __resetSubscriptionsForTesting,
  type GitListChangedFilesSubscriptionResult,
} from "../use-git-list-changed-files-subscription";

// Mock stream session for testing.
class MockStreamSession implements IStreamSession {
  private serverFrameHandler: ServerFrameHandler | null = null;
  private statusChangeHandler: StatusChangeHandler | null = null;
  closed: boolean = false;
  /**
   * The version THIS session negotiated, which is deliberately settable
   * independently of `MockWsStreamClient.methodSchemaVersion`. The two are
   * independent in production too: `reconcileMethodSchemaVersion` reports
   * whichever live session for the method it reaches FIRST, so a second repo's
   * stream can sit at a different minor and never be consulted.
   */
  negotiatedSchemaVersion: SchemaVersion | null = null;

  onServerFrame(handler: ServerFrameHandler): void {
    this.serverFrameHandler = handler;
  }

  getNegotiatedSchemaVersion(): SchemaVersion | null {
    return this.negotiatedSchemaVersion;
  }

  onStatusChange(handler: StatusChangeHandler): void {
    this.statusChangeHandler = handler;
  }

  sendClientFrame(): void {
    // No-op for this test.
  }

  requestReconnect(): void {
    // No-op for this test; reconnect is owned by the real StreamSession.
  }

  close(): void {
    this.closed = true;
    this.statusChangeHandler?.("closed", { kind: "caller" });
  }

  emitFrame(
    event: GitSubscribeStatusEvent,
    binaryPayload: Uint8Array | null,
  ): void {
    if (this.serverFrameHandler !== null) {
      const handler = this.serverFrameHandler;
      const envelope = {
        kind: "event",
        hasBinaryPayload: binaryPayload !== null,
        type: event.type,
        value: event,
      } satisfies StreamFrameEnvelope;
      handler(envelope, binaryPayload);
    }
  }

  emitStatus(
    status: "connecting" | "open" | "reconnecting" | "closed",
    reason: StreamCloseReason | null,
  ): void {
    if (this.statusChangeHandler !== null) {
      this.statusChangeHandler(status, reason);
    }
  }
}

class MockWsStreamClient extends WsStreamClient<HostStreamRpcRegistry> {
  sessions: Map<string, MockStreamSession> = new Map();
  subscribeCallCount: number = 0;
  methodSchemaVersion: SchemaVersion | null = null;
  private readonly supportListeners = new Set<() => void>();

  constructor() {
    super({
      registry: hostStreamRpcRegistry,
      endpoint: () => null,
      bearer: () => null,
      auth: null,
      hostCredentialMint: null,
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
      const created = new MockStreamSession();
      // A session negotiates AT OPEN, so it starts life carrying whatever this
      // client negotiates now. Tests that need the two to diverge - the skew a
      // client-wide read cannot see, and a renegotiation that moves one session
      // and not its sibling - assign the session's own value afterwards.
      created.negotiatedSchemaVersion = this.methodSchemaVersion;
      this.sessions.set(key, created);
    }

    const session = this.sessions.get(key);
    if (session === undefined) {
      throw new Error("Session not found");
    }
    return session;
  }

  getSession(method: string, params: unknown): MockStreamSession | undefined {
    const key = JSON.stringify({ method, params });
    const exact = this.sessions.get(key);
    if (exact !== undefined) return exact;
    if (typeof params !== "object" || params === null) return undefined;
    return this.sessions.get(
      JSON.stringify({
        method,
        params: { ...params, freshNonce: null },
      }),
    );
  }

  override getMethodSchemaVersion<
    Method extends keyof HostStreamRpcRegistry & string,
  >(_method: Method): SchemaVersion | null {
    return this.methodSchemaVersion;
  }

  override subscribeMethodSupport(listener: () => void): () => void {
    this.supportListeners.add(listener);
    return () => {
      this.supportListeners.delete(listener);
    };
  }

  notifySupportChanged(): void {
    this.supportListeners.forEach((listener) => listener());
  }
}

function makeSwappableStreamWrapper(
  queryClient: QueryClient,
  initialStreamClient: WsStreamClient<HostStreamRpcRegistry>,
) {
  const holder: { current: WsStreamClient<HostStreamRpcRegistry> } = {
    current: initialStreamClient,
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <StreamRuntimeContext.Provider
        value={{ wsStreamClient: holder.current, hostId: null }}
      >
        {children}
      </StreamRuntimeContext.Provider>
    </QueryClientProvider>
  );
  return { wrapper, holder };
}

// Shared "swap the context to a fresh replacement client, then prove it takes
// over the subscription and delivers a snapshot without surfacing an error"
// flow used by the replacement-recovery tests below.
async function swapToReplacementClientAndAssertHeadSha(
  holder: { current: WsStreamClient<HostStreamRpcRegistry> },
  rerender: () => void,
  result: { readonly current: GitListChangedFilesSubscriptionResult },
  headSha: string,
) {
  const replacementClient = new MockWsStreamClient();
  holder.current = replacementClient;
  rerender();

  await waitFor(() => {
    expect(replacementClient.subscribeCallCount).toBe(1);
  });
  const replacementSession = replacementClient.getSession(
    "git.subscribeStatus",
    {
      hostId: "host1",
      runningDir: "/repo",
      ignoreWhitespace: false,
    },
  );
  if (replacementSession === undefined) {
    throw new Error("Replacement session should exist");
  }
  replacementSession.emitFrame(
    {
      type: "snapshot",
      runningDir: "/repo",
      headSha,
      branch: "main",
      files: [],
      fingerprint: `${headSha}-fingerprint`,
      repoMode: "normal",
      repoState: { kind: "clean" },
      pollStartedAtMs: 1_000,
    },
    null,
  );

  await waitFor(() => {
    expect(result.current.data?.headSha).toBe(headSha);
  });
  expect(result.current.error).toBeNull();
  expect(result.current.isPending).toBe(false);
}

describe("useGitListChangedFilesSubscription", () => {
  let queryClient: QueryClient;
  let mockWsStreamClient: MockWsStreamClient;

  const createWrapper = () => {
    return ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <StreamRuntimeContext.Provider
          value={{
            wsStreamClient: mockWsStreamClient,
            hostId: null,
          }}
        >
          {children}
        </StreamRuntimeContext.Provider>
      </QueryClientProvider>
    );
  };

  beforeEach(() => {
    __resetSubscriptionsForTesting();
    __resetRichSlotOrderingForTesting();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    mockWsStreamClient = new MockWsStreamClient();
  });

  afterEach(() => {
    __resetSubscriptionsForTesting();
    __resetRichSlotOrderingForTesting();
    queryClient.clear();
    vi.useRealTimers();
  });

  it("single consumer receives snapshot event", async () => {
    const { result } = renderHook(
      () =>
        useGitListChangedFilesSubscription({
          hostId: "host1",
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: true,
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });

    const session = mockWsStreamClient.getSession("git.subscribeStatus", {
      hostId: "host1",
      runningDir: "/repo",
      ignoreWhitespace: false,
    });
    expect(session).toBeDefined();
    if (session === undefined) return;

    const snapshotEvent: GitSubscribeStatusEvent = {
      type: "snapshot",
      runningDir: "/repo",
      headSha: "abc123",
      branch: "main",
      files: [],
      fingerprint: "fp1",
      repoMode: "normal",
      repoState: { kind: "clean" },
      pollStartedAtMs: 1000,
    };

    session.emitFrame(snapshotEvent, null);

    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    expect(result.current.data?.headSha).toBe("abc123");
    expect(result.current.isPending).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("two consumers with same key share one underlying stream", async () => {
    const { result } = renderHook(
      () =>
        useGitListChangedFilesSubscription({
          hostId: "host1",
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: true,
        }),
      { wrapper: createWrapper() },
    );

    renderHook(
      () =>
        useGitListChangedFilesSubscription({
          hostId: "host1",
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: true,
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });

    const session = mockWsStreamClient.getSession("git.subscribeStatus", {
      hostId: "host1",
      runningDir: "/repo",
      ignoreWhitespace: false,
    });
    if (session === undefined) throw new Error("Session not found");

    const snapshotEvent: GitSubscribeStatusEvent = {
      type: "snapshot",
      runningDir: "/repo",
      headSha: "abc123",
      branch: "main",
      files: [],
      fingerprint: "fp1",
      repoMode: "normal",
      repoState: { kind: "clean" },
      pollStartedAtMs: 1000,
    };

    session.emitFrame(snapshotEvent, null);

    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    expect(result.current.data?.headSha).toBe("abc123");
  });

  it("different ignoreWhitespace creates different streams", async () => {
    renderHook(
      () =>
        useGitListChangedFilesSubscription({
          hostId: "host1",
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: true,
        }),
      { wrapper: createWrapper() },
    );

    renderHook(
      () =>
        useGitListChangedFilesSubscription({
          hostId: "host1",
          runningDir: "/repo",
          ignoreWhitespace: true,
          enabled: true,
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(2);
    });
  });

  it("snapshot event writes into listChangedFiles cache", async () => {
    const { result } = renderHook(
      () =>
        useGitListChangedFilesSubscription({
          hostId: "host1",
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: true,
        }),
      { wrapper: createWrapper() },
    );

    const session = mockWsStreamClient.getSession("git.subscribeStatus", {
      hostId: "host1",
      runningDir: "/repo",
      ignoreWhitespace: false,
    });

    const snapshotEvent: GitSubscribeStatusEvent = {
      type: "snapshot",
      runningDir: "/repo",
      headSha: "abc123",
      branch: "main",
      files: [
        {
          path: "/repo/file.ts",
          previousPath: null,
          status: "modified",
          stage: "unstaged",
          isBinary: false,
          insertions: 5,
          deletions: 2,
          sizeBytes: 1000,
          stagedOid: null,
          worktreeOid: "def456",
        },
      ],
      fingerprint: "fp1",
      repoMode: "normal",
      repoState: { kind: "clean" },
      pollStartedAtMs: 1000,
    };

    if (!session) throw new Error("Session should exist");
    session.emitFrame(snapshotEvent, null);

    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    expect(result.current.data?.files).toHaveLength(1);
    expect(result.current.data?.files[0].path).toBe("/repo/file.ts");
  });

  it("updated event writes cache and invalidates only changed file diffs", async () => {
    const { result } = renderHook(
      () =>
        useGitListChangedFilesSubscription({
          hostId: "host1",
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: true,
        }),
      { wrapper: createWrapper() },
    );

    const session = mockWsStreamClient.getSession("git.subscribeStatus", {
      hostId: "host1",
      runningDir: "/repo",
      ignoreWhitespace: false,
    });

    // First, send a snapshot to get data into the cache.
    const snapshotEvent: GitSubscribeStatusEvent = {
      type: "snapshot",
      runningDir: "/repo",
      headSha: "abc123",
      branch: "main",
      files: [
        {
          path: "/repo/file1.ts",
          previousPath: null,
          status: "modified",
          stage: "unstaged",
          isBinary: false,
          insertions: 1,
          deletions: 0,
          sizeBytes: 100,
          stagedOid: null,
          worktreeOid: "def456",
        },
      ],
      fingerprint: "fp1",
      repoMode: "normal",
      repoState: { kind: "clean" },
      pollStartedAtMs: 1000,
    };

    if (!session) throw new Error("Session should exist");
    session.emitFrame(snapshotEvent, null);

    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    const changedDiffKey = gitQueryKeys.fileDiff(
      "host1",
      "/repo",
      "/repo/file1.ts",
      null,
      "unstaged",
      "abc123",
      null,
      "def456",
      false,
      DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
    );
    const unchangedDiffKey = gitQueryKeys.fileDiff(
      "host1",
      "/repo",
      "/repo/file2.ts",
      null,
      "unstaged",
      "abc123",
      null,
      "unchanged",
      false,
      DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
    );
    queryClient.setQueryData(changedDiffKey, { patch: "old" });
    queryClient.setQueryData(unchangedDiffKey, { patch: "stable" });

    // Now send an updated event.
    const updatedEvent: GitSubscribeStatusEvent = {
      type: "updated",
      runningDir: "/repo",
      headSha: "abc124",
      branch: "main",
      files: [
        {
          path: "/repo/file1.ts",
          previousPath: null,
          status: "modified",
          stage: "unstaged",
          isBinary: false,
          insertions: 2,
          deletions: 1,
          sizeBytes: 150,
          stagedOid: null,
          worktreeOid: "xyz789",
        },
      ],
      fingerprint: "fp2",
      changedPaths: ["/repo/file1.ts"],
      repoMode: "normal",
      repoState: { kind: "clean" },
      pollStartedAtMs: 1001,
    };

    session.emitFrame(updatedEvent, null);

    await waitFor(() => {
      // Updated event should refresh the cache.
      expect(result.current.data?.headSha).toBe("abc124");
    });
    await waitFor(() => {
      expect(queryClient.getQueryState(changedDiffKey)?.isInvalidated).toBe(
        true,
      );
    });
    expect(queryClient.getQueryState(unchangedDiffKey)?.isInvalidated).toBe(
      false,
    );
  });

  it("non-fatal error stored without teardown (event is cached)", async () => {
    const { result } = renderHook(
      () =>
        useGitListChangedFilesSubscription({
          hostId: "host1",
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: true,
        }),
      { wrapper: createWrapper() },
    );

    const session = mockWsStreamClient.getSession("git.subscribeStatus", {
      hostId: "host1",
      runningDir: "/repo",
      ignoreWhitespace: false,
    });

    // First snapshot to initialize.
    const snapshotEvent: GitSubscribeStatusEvent = {
      type: "snapshot",
      runningDir: "/repo",
      headSha: "abc123",
      branch: "main",
      files: [],
      fingerprint: "fp1",
      repoMode: "normal",
      repoState: { kind: "clean" },
      pollStartedAtMs: 1000,
    };

    if (!session) throw new Error("Session should exist");
    session.emitFrame(snapshotEvent, null);

    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    const errorEvent: GitSubscribeStatusEvent = {
      type: "error",
      message: "permission denied",
      isFatal: false,
    };

    session.emitFrame(errorEvent, null);

    // The event should be cached in the subscription even if React doesn't re-render yet.
    // This is fine for real usage since subscribers will see it on next query cycle.
    expect(session.closed).toBe(false);
  });

  it("fatal error tears down stream, subsequent subscribe re-opens", async () => {
    const { unmount: unmount1 } = renderHook(
      () =>
        useGitListChangedFilesSubscription({
          hostId: "host1",
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: true,
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });

    const session1 = mockWsStreamClient.getSession("git.subscribeStatus", {
      hostId: "host1",
      runningDir: "/repo",
      ignoreWhitespace: false,
    });

    if (!session1) throw new Error("Session1 should exist");

    const fatalError: GitSubscribeStatusEvent = {
      type: "error",
      message: "fatal error",
      isFatal: true,
    };

    session1.emitFrame(fatalError, null);

    unmount1();

    // Re-subscribe should create a new stream.
    renderHook(
      () =>
        useGitListChangedFilesSubscription({
          hostId: "host1",
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: true,
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(2);
    });
  });

  it("transport-terminal close surfaces a fatal error instead of pending forever", async () => {
    const { result } = renderHook(
      () =>
        useGitListChangedFilesSubscription({
          hostId: "host1",
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: true,
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });

    const session = mockWsStreamClient.getSession("git.subscribeStatus", {
      hostId: "host1",
      runningDir: "/repo",
      ignoreWhitespace: false,
    });
    if (!session) throw new Error("Session should exist");

    // A transport-terminal close (fatal error frame, closed client, the
    // UNAUTHORIZED give-up) produces NO domain error frame - only a status
    // transition. It must surface as a fatal error, not an eternal skeleton.
    act(() => {
      session.emitStatus("closed", {
        kind: "fatalError",
        details: {
          code: "UNAUTHORIZED",
          reason: "gave up after no-progress reconnects",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      });
    });

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });
    const error = result.current.error;
    if (error === null || error.type !== "error") {
      throw new Error("Expected an error event");
    }
    expect(error.isFatal).toBe(true);
    expect(error.message).toContain("UNAUTHORIZED");
    expect(result.current.isPending).toBe(false);
    expect(session.closed).toBe(true);
  });

  it("waits for a replacement client and recovers without surfacing CLIENT_CLOSED", async () => {
    const closedClient = new WsStreamClient<HostStreamRpcRegistry>({
      registry: hostStreamRpcRegistry,
      endpoint: () => null,
      bearer: () => null,
      auth: null,
      hostCredentialMint: null,
      webSocketFactory: {
        create: () => {
          throw new Error("a closed client must not dial");
        },
      },
      dialTimeoutMs: 1_000,
      openAckTimeoutMs: 1_000,
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });
    closedClient.close("test-close");

    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const { wrapper, holder } = makeSwappableStreamWrapper(
      queryClient,
      closedClient,
    );

    const { result, rerender } = renderHook(
      () =>
        useGitListChangedFilesSubscription({
          hostId: "host1",
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: true,
        }),
      { wrapper },
    );

    expect(result.current.error).toBeNull();
    expect(result.current.isPending).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();

    await swapToReplacementClientAndAssertHeadSha(
      holder,
      rerender,
      result,
      "replacement-head",
    );
    warnSpy.mockRestore();
  });

  it("detaches when the live client closes underneath and rebinds to a replacement", async () => {
    const liveClient = new MockWsStreamClient();
    const { wrapper, holder } = makeSwappableStreamWrapper(
      queryClient,
      liveClient,
    );

    const { result, rerender } = renderHook(
      () =>
        useGitListChangedFilesSubscription({
          hostId: "host1",
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: true,
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(liveClient.subscribeCallCount).toBe(1);
    });
    const liveSession = liveClient.getSession("git.subscribeStatus", {
      hostId: "host1",
      runningDir: "/repo",
      ignoreWhitespace: false,
    });
    if (liveSession === undefined) {
      throw new Error("Live session should exist");
    }

    liveSession.emitFrame(
      {
        type: "snapshot",
        runningDir: "/repo",
        headSha: "initial-head",
        branch: "main",
        files: [],
        fingerprint: "initial-fingerprint",
        repoMode: "normal",
        repoState: { kind: "clean" },
        pollStartedAtMs: 1_000,
      },
      null,
    );
    await waitFor(() => {
      expect(result.current.data?.headSha).toBe("initial-head");
    });

    // Close the LIVE client underneath the consumer with NO parent rerender.
    // The `onClosed` subscription in `useWsStreamClient` must notify on its own,
    // flip the served snapshot to null, and drive the consumer to detach - its
    // effect cleanup closes the session - WITHOUT surfacing CLIENT_CLOSED. If
    // the subscribe branch were dropped, nothing would re-read the snapshot on
    // this close and the consumer would cling to the dead client's session.
    act(() => {
      liveClient.close("closed-underneath");
    });

    expect(liveSession.closed).toBe(true);
    expect(result.current.error).toBeNull();

    // A replacement client reaches context (the provider's liveness rebuild).
    await swapToReplacementClientAndAssertHeadSha(
      holder,
      rerender,
      result,
      "replacement-head",
    );
  });

  it("a rebuilt stream client gets a fresh subscription (per-client keying)", async () => {
    const { rerender } = renderHook(
      () =>
        useGitListChangedFilesSubscription({
          hostId: "host1",
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: true,
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });
    const firstClient = mockWsStreamClient;
    const firstSession = firstClient.getSession("git.subscribeStatus", {
      hostId: "host1",
      runningDir: "/repo",
      ignoreWhitespace: false,
    });
    if (!firstSession) throw new Error("Session should exist");

    // Swap the context to a NEW client - a provider rebuild after host swap or
    // the liveness guard. The shared map is keyed per client instance, so the
    // consumer must drain the old entry (closing its session) and open a fresh
    // subscription on the new client instead of clinging to the dead session.
    mockWsStreamClient = new MockWsStreamClient();
    rerender();

    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });
    expect(firstSession.closed).toBe(true);
    expect(firstClient.instanceId).not.toBe(mockWsStreamClient.instanceId);
  });

  it("last unmount tears down immediately (no grace period, ADR-0003)", async () => {
    const { unmount } = renderHook(
      () =>
        useGitListChangedFilesSubscription({
          hostId: "host1",
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: true,
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    });

    const session = mockWsStreamClient.getSession("git.subscribeStatus", {
      hostId: "host1",
      runningDir: "/repo",
      ignoreWhitespace: false,
    });

    expect(session?.closed).toBe(false);

    unmount();

    expect(session?.closed).toBe(true);
  });

  it("does not write the rich slot for a v1.0 stream frame", async () => {
    mockWsStreamClient.methodSchemaVersion = { major: 1, minor: 0 };
    const richKey = gitQueryKeys.listChangedFilesWithSubmodules(
      "host1",
      "/repo",
      false,
    );
    const sentinel = {
      runningDir: "/repo",
      headSha: "sentinel",
      branch: "main",
      files: [],
      fingerprint: "rich-sentinel",
      repoMode: "normal" as const,
      repoState: { kind: "clean" as const },
      submodules: [],
    };
    queryClient.setQueryData(richKey, sentinel);

    renderHook(
      () =>
        useGitListChangedFilesSubscription({
          hostId: "host1",
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: true,
        }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(mockWsStreamClient.subscribeCallCount).toBe(1));
    const session = mockWsStreamClient.getSession("git.subscribeStatus", {
      hostId: "host1",
      runningDir: "/repo",
      ignoreWhitespace: false,
    });
    if (session === undefined) throw new Error("Session not found");

    session.emitFrame(
      {
        type: "snapshot",
        runningDir: "/repo",
        headSha: "v10-head",
        branch: "main",
        files: [],
        fingerprint: "parent-fingerprint",
        repoMode: "normal",
        repoState: { kind: "clean" },
        pollStartedAtMs: 1_000,
      },
      null,
    );

    await waitFor(() =>
      expect(
        queryClient.getQueryData(
          gitQueryKeys.listChangedFiles("host1", "/repo", false),
        ),
      ).not.toBeUndefined(),
    );
    expect(queryClient.getQueryData(richKey)).toEqual(sentinel);
  });

  it("writes both cache slots and submodule diff invalidation for a v1.1 frame", async () => {
    mockWsStreamClient.methodSchemaVersion = { major: 1, minor: 1 };
    const parentFile = {
      path: "/repo/parent.ts",
      previousPath: null,
      status: "modified" as const,
      stage: "unstaged" as const,
      isBinary: false,
      insertions: 1,
      deletions: 0,
      sizeBytes: 1,
      stagedOid: null,
      worktreeOid: "parent-oid",
      gitlink: {
        kind: "normal" as const,
        recordedPinSha: "pin",
        submoduleHeadSha: "head",
        diverged: true,
        commitChanged: true,
        modifiedContent: false,
        untrackedContent: false,
      },
    };
    const submoduleFile = {
      path: "src/nested.ts",
      previousPath: null,
      status: "modified" as const,
      stage: "unstaged" as const,
      isBinary: false,
      insertions: 2,
      deletions: 1,
      sizeBytes: 2,
      stagedOid: null,
      worktreeOid: "nested-oid",
      gitlink: null,
    };
    const submodule = {
      repoRoot: "/repo/submodule",
      parentPath: "submodule",
      branch: "main",
      repoState: { kind: "clean" as const },
      files: [submoduleFile],
      pointer: parentFile.gitlink,
      availability: { state: "ok" as const },
      changedPaths: ["src/nested.ts"],
    };
    renderHook(
      () =>
        useGitListChangedFilesSubscription({
          hostId: "host1",
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: true,
        }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(mockWsStreamClient.subscribeCallCount).toBe(1));
    const session = mockWsStreamClient.getSession("git.subscribeStatus", {
      hostId: "host1",
      runningDir: "/repo",
      ignoreWhitespace: false,
    });
    if (session === undefined) throw new Error("Session not found");

    const parentDiffKey = gitQueryKeys.fileDiff(
      "host1",
      "/repo",
      "/repo/parent.ts",
      null,
      "unstaged",
      "head",
      null,
      "parent-oid",
      false,
      DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
    );
    const submoduleDiffKey = gitQueryKeys.fileDiff(
      "host1",
      "/repo/submodule",
      "src/nested.ts",
      null,
      "unstaged",
      "head",
      null,
      "nested-oid",
      false,
      DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
    );
    queryClient.setQueryData(parentDiffKey, { patch: "old" });
    queryClient.setQueryData(submoduleDiffKey, { patch: "old" });

    const event: GitSubscribeStatusEventV11 = {
      type: "updated",
      runningDir: "/repo",
      headSha: "new-head",
      branch: "main",
      files: [parentFile],
      fingerprint: "parent-fingerprint",
      nestedFingerprint: "nested-fingerprint",
      repoMode: "normal",
      repoState: { kind: "clean" },
      changedPaths: ["/repo/parent.ts"],
      submodules: [submodule],
      pollStartedAtMs: 1_001,
    };
    session.emitFrame(event, null);

    await waitFor(() =>
      expect(
        queryClient.getQueryData<GitListChangedFilesResponse>(
          gitQueryKeys.listChangedFiles("host1", "/repo", false),
        ),
      ).not.toBeUndefined(),
    );
    const v10 = queryClient.getQueryData<GitListChangedFilesResponse>(
      gitQueryKeys.listChangedFiles("host1", "/repo", false),
    );
    expect(v10).toMatchObject({ fingerprint: "parent-fingerprint" });
    expect(v10).toMatchObject({ files: [{ path: "/repo/parent.ts" }] });
    expect(v10?.files[0]).not.toHaveProperty("gitlink");

    const rich = queryClient.getQueryData<GitListChangedFilesResponseV11>(
      gitQueryKeys.listChangedFilesWithSubmodules("host1", "/repo", false),
    );
    expect(rich).toMatchObject({ fingerprint: "nested-fingerprint" });
    expect(rich?.files[0]).toHaveProperty("gitlink");
    await waitFor(() => {
      expect(queryClient.getQueryState(parentDiffKey)?.isInvalidated).toBe(
        true,
      );
      expect(queryClient.getQueryState(submoduleDiffKey)?.isInvalidated).toBe(
        true,
      );
    });
  });

  it("replays a cached rich event for a joining consumer without re-invalidating diffs", async () => {
    mockWsStreamClient.methodSchemaVersion = { major: 1, minor: 1 };
    const { unmount: unmountFirst } = renderHook(
      () =>
        useGitListChangedFilesSubscription({
          hostId: "host1",
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: true,
        }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(mockWsStreamClient.subscribeCallCount).toBe(1));
    const session = mockWsStreamClient.getSession("git.subscribeStatus", {
      hostId: "host1",
      runningDir: "/repo",
      ignoreWhitespace: false,
    });
    if (session === undefined) throw new Error("Session not found");

    const richKey = gitQueryKeys.listChangedFilesWithSubmodules(
      "host1",
      "/repo",
      false,
    );
    const diffKey = gitQueryKeys.fileDiff(
      "host1",
      "/repo",
      "/repo/file.ts",
      null,
      "unstaged",
      "head-1",
      null,
      "oid-1",
      false,
      DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
    );
    queryClient.setQueryData(diffKey, { patch: "old" });
    const event: GitSubscribeStatusEventV11 = {
      type: "updated",
      runningDir: "/repo",
      headSha: "head-1",
      branch: "main",
      files: [],
      fingerprint: "parent-1",
      nestedFingerprint: "nested-1",
      repoMode: "normal",
      repoState: { kind: "clean" },
      changedPaths: ["/repo/file.ts"],
      submodules: [],
      pollStartedAtMs: 1_001,
    };
    session.emitFrame(event, null);
    await waitFor(() =>
      expect(queryClient.getQueryData(richKey)).not.toBeUndefined(),
    );

    queryClient.removeQueries({ queryKey: richKey });
    queryClient.removeQueries({ queryKey: diffKey });
    queryClient.setQueryData(diffKey, { patch: "stable" });

    renderHook(
      () =>
        useGitListChangedFilesSubscription({
          hostId: "host1",
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: true,
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() =>
      expect(queryClient.getQueryData(richKey)).not.toBeUndefined(),
    );
    expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    expect(queryClient.getQueryState(diffKey)?.isInvalidated).toBe(false);
    unmountFirst();
  });

  it("replays only the v1.0 slot when a joining consumer negotiates minor zero", async () => {
    mockWsStreamClient.methodSchemaVersion = { major: 1, minor: 1 };
    const { unmount: unmountFirst } = renderHook(
      () =>
        useGitListChangedFilesSubscription({
          hostId: "host1",
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: true,
        }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(mockWsStreamClient.subscribeCallCount).toBe(1));
    const session = mockWsStreamClient.getSession("git.subscribeStatus", {
      hostId: "host1",
      runningDir: "/repo",
      ignoreWhitespace: false,
    });
    if (session === undefined) throw new Error("Session not found");
    const event: GitSubscribeStatusEventV11 = {
      type: "snapshot",
      runningDir: "/repo",
      headSha: "head-2",
      branch: "main",
      files: [],
      fingerprint: "parent-2",
      nestedFingerprint: "nested-2",
      repoMode: "normal",
      repoState: { kind: "clean" },
      submodules: [],
      pollStartedAtMs: 2_000,
    };
    session.emitFrame(event, null);
    const richKey = gitQueryKeys.listChangedFilesWithSubmodules(
      "host1",
      "/repo",
      false,
    );
    await waitFor(() =>
      expect(queryClient.getQueryData(richKey)).not.toBeUndefined(),
    );

    queryClient.removeQueries({ queryKey: richKey });
    queryClient.removeQueries({
      queryKey: gitQueryKeys.listChangedFiles("host1", "/repo", false),
    });
    // THIS session is what renegotiated down - replay reads the entry's own
    // session, so moving only the client-wide value would model a DIFFERENT
    // repo's stream dropping to minor 0, which must not touch this one.
    session.negotiatedSchemaVersion = { major: 1, minor: 0 };
    mockWsStreamClient.methodSchemaVersion = { major: 1, minor: 0 };

    renderHook(
      () =>
        useGitListChangedFilesSubscription({
          hostId: "host1",
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: true,
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() =>
      expect(
        queryClient.getQueryData(
          gitQueryKeys.listChangedFiles("host1", "/repo", false),
        ),
      ).not.toBeUndefined(),
    );
    expect(queryClient.getQueryData(richKey)).toBeUndefined();
    expect(
      queryClient.getQueryData<GitListChangedFilesResponse>(
        gitQueryKeys.listChangedFiles("host1", "/repo", false),
      ),
    ).toMatchObject({ fingerprint: "parent-2" });
    expect(mockWsStreamClient.subscribeCallCount).toBe(1);
    unmountFirst();
  });

  it("shares a v1.2 nonce refresh, ignores stale/non-matching frames, and preserves the cache until the match", async () => {
    mockWsStreamClient.methodSchemaVersion = { major: 1, minor: 2 };
    const randomUuid = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue("11111111-1111-1111-1111-111111111111");
    try {
      const { result: subscription } = renderHook(
        () =>
          useGitListChangedFilesSubscription({
            hostId: "host1",
            runningDir: "/repo",
            ignoreWhitespace: false,
            enabled: true,
          }),
        { wrapper: createWrapper() },
      );
      const { result: refreshState } = renderHook(
        () =>
          useGitSubscriptionRefreshState({
            wsStreamClient: mockWsStreamClient,
            hostId: "host1",
            runningDir: "/repo",
            ignoreWhitespace: false,
          }),
        { wrapper: createWrapper() },
      );
      await waitFor(() =>
        expect(mockWsStreamClient.subscribeCallCount).toBe(1),
      );
      const oldSession = mockWsStreamClient.getSession("git.subscribeStatus", {
        hostId: "host1",
        runningDir: "/repo",
        ignoreWhitespace: false,
      });
      if (oldSession === undefined) throw new Error("Expected initial session");

      const startRefresh = () =>
        refreshGitSubscriptionWithFreshNonce({
          wsStreamClient: mockWsStreamClient,
          queryClient,
          hostId: "host1",
          runningDir: "/repo",
          ignoreWhitespace: false,
        });
      const first = startRefresh();
      const second = startRefresh();
      if (first === null || second === null)
        throw new Error("Expected v1.2 refresh");
      expect(second).toBe(first);
      expect(oldSession.closed).toBe(true);
      await waitFor(() => expect(refreshState.current).toBe(true));

      const replacement = mockWsStreamClient.getSession("git.subscribeStatus", {
        hostId: "host1",
        runningDir: "/repo",
        ignoreWhitespace: false,
        freshNonce: "11111111-1111-1111-1111-111111111111",
      });
      if (replacement === undefined)
        throw new Error("Expected replacement session");
      const event = (
        freshNonce: string,
        headSha: string,
      ): GitSubscribeStatusEventV12 => ({
        type: "snapshot",
        runningDir: "/repo",
        headSha,
        branch: "main",
        files: [],
        fingerprint: `parent-${headSha}`,
        nestedFingerprint: `nested-${headSha}`,
        repoMode: "normal",
        repoState: { kind: "clean" },
        submodules: [],
        pollStartedAtMs: 1_000,
        freshNonce,
      });
      oldSession.emitFrame(
        event("11111111-1111-1111-1111-111111111111", "old-generation"),
        null,
      );
      replacement.emitFrame(event("wrong-nonce", "wrong"), null);
      await Promise.resolve();
      expect(subscription.current.data).toBeNull();
      expect(refreshState.current).toBe(true);

      replacement.emitFrame(
        event("11111111-1111-1111-1111-111111111111", "fresh"),
        null,
      );
      await expect(first).resolves.toBeUndefined();
      await waitFor(() => expect(refreshState.current).toBe(false));
      expect(subscription.current.data?.headSha).toBe("fresh");
    } finally {
      randomUuid.mockRestore();
    }
  });

  it("keeps a matching-nonce updated frame pending until the targeted snapshot", async () => {
    mockWsStreamClient.methodSchemaVersion = { major: 1, minor: 2 };
    const randomUuid = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue("44444444-4444-4444-4444-444444444444");
    try {
      const { result: subscription } = renderHook(
        () =>
          useGitListChangedFilesSubscription({
            hostId: "host1",
            runningDir: "/repo",
            ignoreWhitespace: false,
            enabled: true,
          }),
        { wrapper: createWrapper() },
      );
      const { result: refreshState } = renderHook(
        () =>
          useGitSubscriptionRefreshState({
            wsStreamClient: mockWsStreamClient,
            hostId: "host1",
            runningDir: "/repo",
            ignoreWhitespace: false,
          }),
        { wrapper: createWrapper() },
      );
      await waitFor(() =>
        expect(mockWsStreamClient.subscribeCallCount).toBe(1),
      );

      const refresh = refreshGitSubscriptionWithFreshNonce({
        wsStreamClient: mockWsStreamClient,
        queryClient,
        hostId: "host1",
        runningDir: "/repo",
        ignoreWhitespace: false,
      });
      if (refresh === null) throw new Error("Expected v1.2 refresh");
      await waitFor(() => expect(refreshState.current).toBe(true));

      const replacement = mockWsStreamClient.getSession("git.subscribeStatus", {
        hostId: "host1",
        runningDir: "/repo",
        ignoreWhitespace: false,
        freshNonce: "44444444-4444-4444-4444-444444444444",
      });
      if (replacement === undefined)
        throw new Error("Expected replacement session");

      const matchingUpdated: GitSubscribeStatusEventV12 = {
        type: "updated",
        runningDir: "/repo",
        headSha: "updated",
        branch: "main",
        files: [],
        fingerprint: "parent-updated",
        nestedFingerprint: "nested-updated",
        repoMode: "normal",
        repoState: { kind: "clean" },
        changedPaths: [],
        submodules: [],
        pollStartedAtMs: 1_001,
        freshNonce: "44444444-4444-4444-4444-444444444444",
      };
      replacement.emitFrame(matchingUpdated, null);
      await Promise.resolve();

      expect(refreshState.current).toBe(true);
      expect(subscription.current.data).toBeNull();

      const matchingSnapshot: GitSubscribeStatusEventV12 = {
        type: "snapshot",
        runningDir: "/repo",
        headSha: "fresh",
        branch: "main",
        files: [],
        fingerprint: "parent-fresh",
        nestedFingerprint: "nested-fresh",
        repoMode: "normal",
        repoState: { kind: "clean" },
        submodules: [],
        pollStartedAtMs: 1_002,
        freshNonce: "44444444-4444-4444-4444-444444444444",
      };
      replacement.emitFrame(matchingSnapshot, null);
      await expect(refresh).resolves.toBeUndefined();
      await waitFor(() => expect(refreshState.current).toBe(false));
      expect(subscription.current.data?.headSha).toBe("fresh");
    } finally {
      randomUuid.mockRestore();
    }
  });

  it("settles a shared refresh once at 10 seconds while leaving its replacement stream alive", async () => {
    vi.useFakeTimers();
    mockWsStreamClient.methodSchemaVersion = { major: 1, minor: 2 };
    const randomUuid = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue("22222222-2222-2222-2222-222222222222");
    try {
      renderHook(
        () =>
          useGitListChangedFilesSubscription({
            hostId: "host1",
            runningDir: "/repo",
            ignoreWhitespace: false,
            enabled: true,
          }),
        { wrapper: createWrapper() },
      );
      await vi.advanceTimersByTimeAsync(0);
      const first = refreshGitSubscriptionWithFreshNonce({
        wsStreamClient: mockWsStreamClient,
        queryClient,
        hostId: "host1",
        runningDir: "/repo",
        ignoreWhitespace: false,
      });
      const second = refreshGitSubscriptionWithFreshNonce({
        wsStreamClient: mockWsStreamClient,
        queryClient,
        hostId: "host1",
        runningDir: "/repo",
        ignoreWhitespace: false,
      });
      if (first === null || second === null)
        throw new Error("Expected v1.2 refresh");
      expect(second).toBe(first);
      let settlements = 0;
      void first.then(() => {
        settlements += 1;
      });

      await vi.advanceTimersByTimeAsync(10_000);
      await expect(first).resolves.toBeUndefined();
      expect(settlements).toBe(1);
      const replacement = mockWsStreamClient.getSession("git.subscribeStatus", {
        hostId: "host1",
        runningDir: "/repo",
        ignoreWhitespace: false,
        freshNonce: "22222222-2222-2222-2222-222222222222",
      });
      expect(replacement?.closed).toBe(false);
    } finally {
      randomUuid.mockRestore();
    }
  });

  it("settles a pending refresh on a terminal replacement error and closes that stream", async () => {
    mockWsStreamClient.methodSchemaVersion = { major: 1, minor: 2 };
    const randomUuid = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue("33333333-3333-3333-3333-333333333333");
    try {
      renderHook(
        () =>
          useGitListChangedFilesSubscription({
            hostId: "host1",
            runningDir: "/repo",
            ignoreWhitespace: false,
            enabled: true,
          }),
        { wrapper: createWrapper() },
      );
      await waitFor(() =>
        expect(mockWsStreamClient.subscribeCallCount).toBe(1),
      );

      const refresh = refreshGitSubscriptionWithFreshNonce({
        wsStreamClient: mockWsStreamClient,
        queryClient,
        hostId: "host1",
        runningDir: "/repo",
        ignoreWhitespace: false,
      });
      if (refresh === null) throw new Error("Expected v1.2 refresh");

      const replacement = mockWsStreamClient.getSession("git.subscribeStatus", {
        hostId: "host1",
        runningDir: "/repo",
        ignoreWhitespace: false,
        freshNonce: "33333333-3333-3333-3333-333333333333",
      });
      if (replacement === undefined)
        throw new Error("Expected replacement session");

      let settlements = 0;
      void refresh.then(() => {
        settlements += 1;
      });
      replacement.emitFrame(
        { type: "error", message: "fatal git error", isFatal: true },
        null,
      );

      await expect(refresh).resolves.toBeUndefined();
      await Promise.resolve();
      expect(settlements).toBe(1);
      expect(replacement.closed).toBe(true);
    } finally {
      randomUuid.mockRestore();
    }
  });

  describe("watcher health (v1.3)", () => {
    function v13Snapshot(
      watcher: GitWatcherStatus,
    ): GitSubscribeStatusEventV13 {
      return {
        type: "snapshot",
        runningDir: "/repo",
        headSha: "head",
        branch: "main",
        files: [],
        fingerprint: "parent-1",
        nestedFingerprint: "nested-1",
        repoMode: "normal",
        repoState: { kind: "clean" },
        submodules: [],
        pollStartedAtMs: 1_000,
        freshNonce: null,
        watcher,
      };
    }

    async function renderAtMinor(minor: number) {
      mockWsStreamClient.methodSchemaVersion = { major: 1, minor };
      const rendered = renderHook(
        () =>
          useGitListChangedFilesSubscription({
            hostId: "host1",
            runningDir: "/repo",
            ignoreWhitespace: false,
            enabled: true,
          }),
        { wrapper: createWrapper() },
      );
      await waitFor(() =>
        expect(mockWsStreamClient.subscribeCallCount).toBe(1),
      );
      const session = mockWsStreamClient.getSession("git.subscribeStatus", {
        hostId: "host1",
        runningDir: "/repo",
        ignoreWhitespace: false,
        ...(minor >= 2 ? { freshNonce: null } : {}),
      });
      if (session === undefined) throw new Error("Expected session");
      return { result: rendered.result, session };
    }

    it("surfaces watcher health from a v1.3 frame", async () => {
      const { result, session } = await renderAtMinor(3);
      expect(result.current.watcherStatus).toBeNull();

      session.emitFrame(
        v13Snapshot({ state: "degraded-capacity", detail: "over budget" }),
        null,
      );
      await waitFor(() =>
        expect(result.current.watcherStatus).toEqual({
          state: "degraded-capacity",
          detail: "over budget",
        }),
      );
      // The frame still populates the cache exactly as a v1.2 frame would -
      // watcher health rides ALONGSIDE the changeset, it does not replace it.
      expect(result.current.data?.fingerprint).toBe("parent-1");

      session.emitFrame(v13Snapshot({ state: "watching", detail: null }), null);
      await waitFor(() =>
        expect(result.current.watcherStatus).toEqual({
          state: "watching",
          detail: null,
        }),
      );
    });

    it("reports UNKNOWN, not healthy, against a host negotiated below 1.3", async () => {
      // The distinction matters: a released host emits no watcher field at
      // all, and rendering that as "watching" would assert live updates this
      // client has no evidence for.
      const { result, session } = await renderAtMinor(2);
      const v12: GitSubscribeStatusEventV12 = {
        type: "snapshot",
        runningDir: "/repo",
        headSha: "head",
        branch: "main",
        files: [],
        fingerprint: "parent-1",
        nestedFingerprint: "nested-1",
        repoMode: "normal",
        repoState: { kind: "clean" },
        submodules: [],
        pollStartedAtMs: 1_000,
        freshNonce: null,
      };
      session.emitFrame(v12, null);
      await waitFor(() =>
        expect(result.current.data?.fingerprint).toBe("parent-1"),
      );
      expect(result.current.watcherStatus).toBeNull();
    });

    it("ignores a watcher field arriving on a connection negotiated at 1.2", async () => {
      // Defence in depth against a host that projects incorrectly: the v1.2
      // schema parse strips the field, so it can never reach the UI.
      const { result, session } = await renderAtMinor(2);
      session.emitFrame(
        v13Snapshot({ state: "degraded-error", detail: "boom" }),
        null,
      );
      await waitFor(() =>
        expect(result.current.data?.fingerprint).toBe("parent-1"),
      );
      expect(result.current.watcherStatus).toBeNull();
    });

    it("holds watcher health across a git error frame", async () => {
      // Error frames carry no watcher field, and a git-compute failure says
      // nothing about the watcher. Dropping the value here would hide the
      // notice for the whole error backoff - precisely when the panel is
      // showing stale data and the staleness needs explaining.
      const { result, session } = await renderAtMinor(3);
      session.emitFrame(
        v13Snapshot({ state: "degraded-error", detail: "boom" }),
        null,
      );
      await waitFor(() => expect(result.current.watcherStatus).not.toBeNull());

      session.emitFrame(
        { type: "error", message: "transient", isFatal: false },
        null,
      );
      await waitFor(() => expect(result.current.error).not.toBeNull());
      expect(result.current.watcherStatus).toEqual({
        state: "degraded-error",
        detail: "boom",
      });
    });

    it("drops watcher health when the stream terminates for good", async () => {
      // The mirror of the test above, and the distinction is whether anything
      // is still arriving. A non-fatal git error keeps polling, so "refreshing
      // on a timer" stays true; a fatal frame means no frame will ever arrive
      // again, and continuing to promise periodic refreshes is a lie the
      // panel is especially good at hiding behind cached data.
      const { result, session } = await renderAtMinor(3);
      session.emitFrame(
        v13Snapshot({ state: "degraded-capacity", detail: "over budget" }),
        null,
      );
      await waitFor(() => expect(result.current.watcherStatus).not.toBeNull());

      session.emitFrame(
        { type: "error", message: "fatal git error", isFatal: true },
        null,
      );
      await waitFor(() => expect(result.current.error).not.toBeNull());
      expect(result.current.watcherStatus).toBeNull();
    });

    it("drops watcher health when the transport closes", async () => {
      const { result, session } = await renderAtMinor(3);
      session.emitFrame(
        v13Snapshot({ state: "degraded-capacity", detail: "over budget" }),
        null,
      );
      await waitFor(() => expect(result.current.watcherStatus).not.toBeNull());

      // A closed transport produces no domain error frame at all, so this
      // path has to clear the value on its own.
      session.emitStatus("closed", { kind: "caller" });
      await waitFor(() => expect(result.current.error).not.toBeNull());
      expect(result.current.watcherStatus).toBeNull();
    });

    it("clears watcher health when the connection renegotiates below 1.3", async () => {
      // Cold-review finding: writing `lastWatcherStatus` only when the field
      // is PRESENT makes it a latch. The same client instance can reconnect to
      // a restarted or rolled-back host and negotiate down, and then no frame
      // is able to clear a notice describing a host generation that is gone.
      const { result, session } = await renderAtMinor(3);
      session.emitFrame(
        v13Snapshot({ state: "degraded-error", detail: "boom" }),
        null,
      );
      await waitFor(() => expect(result.current.watcherStatus).not.toBeNull());

      // THIS session is what renegotiated down; the client-wide value follows
      // it only because it is the sole live session for the method.
      session.negotiatedSchemaVersion = { major: 1, minor: 2 };
      mockWsStreamClient.methodSchemaVersion = { major: 1, minor: 2 };
      const downgraded: GitSubscribeStatusEventV12 = {
        type: "updated",
        runningDir: "/repo",
        headSha: "head-2",
        branch: "main",
        files: [],
        fingerprint: "parent-2",
        nestedFingerprint: "nested-2",
        repoMode: "normal",
        repoState: { kind: "clean" },
        changedPaths: [],
        submodules: [],
        pollStartedAtMs: 2_000,
        freshNonce: null,
      };
      session.emitFrame(downgraded, null);
      await waitFor(() =>
        expect(result.current.data?.fingerprint).toBe("parent-2"),
      );
      expect(result.current.watcherStatus).toBeNull();
    });

    it("DROPS a watcher-less frame on a session that itself negotiated 1.3", async () => {
      // The invariant that replaced the tolerant v1.2 fallback. That fallback
      // existed because the tier came from the CLIENT-WIDE version and could
      // belong to a sibling repo's stream, making a watcher-less frame ordinary
      // version skew; the skew case now lives in "per-session schema version"
      // below, where it is accepted because that session really is at 1.2.
      //
      // Here the delivering session negotiated 1.3 itself, so this host agreed
      // to send `watcher` and a frame without one is malformed. Degrading it to
      // a v1.2 parse would strip the offending shape and accept a payload the
      // contract exists to reject.
      const { result, session } = await renderAtMinor(3);
      session.emitFrame(v13Snapshot({ state: "watching", detail: null }), null);
      await waitFor(() =>
        expect(result.current.data?.fingerprint).toBe("parent-1"),
      );

      const watcherless: GitSubscribeStatusEventV12 = {
        type: "snapshot",
        runningDir: "/repo",
        headSha: "head",
        branch: "main",
        files: [],
        fingerprint: "parent-watcherless",
        nestedFingerprint: "nested-watcherless",
        repoMode: "normal",
        repoState: { kind: "clean" },
        submodules: [],
        pollStartedAtMs: 1_000,
        freshNonce: null,
      };
      session.emitFrame(watcherless, null);

      // ORDERING, not a sleep: `emitFrame` is synchronous, so a later
      // well-formed frame becoming visible proves the dropped one was already
      // processed.
      const base = v13Snapshot({ state: "watching", detail: null });
      if (base.type !== "snapshot") throw new Error("expected a snapshot");
      session.emitFrame({ ...base, fingerprint: "parent-after" }, null);
      await waitFor(() =>
        expect(result.current.data?.fingerprint).toBe("parent-after"),
      );
      expect(result.current.data?.fingerprint).not.toBe("parent-watcherless");
    });

    it("DROPS a malformed watcher rather than downgrading it into a v1.2 parse", async () => {
      // The skew fallback must not become a bypass for the wire contract. A
      // frame that CARRIES a watcher and still fails v1.3 is malformed - an
      // unknown `state`, say - and the non-strict v1.2 schema would happily
      // "rescue" it by stripping the offending field, recording the watcher as
      // UNKNOWN and accepting a payload the contract exists to reject. Only a
      // frame with no `watcher` key at all is version skew.
      const { result, session } = await renderAtMinor(3);
      session.emitFrame(
        v13Snapshot({ state: "degraded-capacity", detail: "over budget" }),
        null,
      );
      await waitFor(() =>
        expect(result.current.data?.fingerprint).toBe("parent-1"),
      );

      const malformed = {
        ...v13Snapshot({ state: "degraded-capacity", detail: null }),
        fingerprint: "parent-malformed",
        watcher: { state: "not-a-real-state", detail: null },
      };
      session.emitFrame(malformed, null);

      // ORDERING, not a sleep: `emitFrame` runs the handler synchronously, so
      // once a LATER well-formed frame is visible the malformed one has
      // provably already been processed. A fixed delay would add dead time to
      // every run and stay timing-dependent under load.
      // Narrowed before the spread: `v13Snapshot` is typed as the whole union,
      // and spreading it unnarrowed leaves `type` as a union, so TS cannot pick
      // the member the extra `fingerprint` belongs to.
      const base = v13Snapshot({
        state: "degraded-capacity",
        detail: "over budget",
      });
      if (base.type !== "snapshot") throw new Error("expected a snapshot");
      const after: GitSubscribeStatusEventV13 = {
        ...base,
        fingerprint: "parent-after",
      };
      session.emitFrame(after, null);
      await waitFor(() =>
        expect(result.current.data?.fingerprint).toBe("parent-after"),
      );

      // The malformed frame's payload never landed, and the watcher it carried
      // never displaced the known-good value.
      expect(result.current.data?.fingerprint).not.toBe("parent-malformed");
      expect(result.current.watcherStatus).toEqual({
        state: "degraded-capacity",
        detail: "over budget",
      });
    });

    it("clears watcher health while the socket is RECONNECTING, not only on close", async () => {
      // A recoverable drop parks the logical session at "reconnecting", never
      // "closed", so `markTerminal` is not on that path. Without an explicit
      // clear the notice survives the whole backoff - stating "Periodic
      // refresh" as fact while no frame can arrive to contradict it.
      const { result, session } = await renderAtMinor(3);
      session.emitFrame(
        v13Snapshot({ state: "degraded-error", detail: "boom" }),
        null,
      );
      await waitFor(() => expect(result.current.watcherStatus).not.toBeNull());

      session.emitStatus("reconnecting", null);
      await waitFor(() => expect(result.current.watcherStatus).toBeNull());
      // Not terminal: the stream is still expected to recover, so this must
      // not masquerade as a fatal error.
      expect(result.current.error).toBeNull();
    });

    it("drops watcher health when the session is REPLACED, not only when it terminates", async () => {
      // Replacement retires the generation and makes the old session's
      // callbacks inert, so nothing downstream can clear the value on its
      // behalf — and the replacement may reach a different host incarnation.
      // `markTerminal` covers the terminal path only.
      const { result, session } = await renderAtMinor(3);
      session.emitFrame(
        v13Snapshot({ state: "degraded-error", detail: "boom" }),
        null,
      );
      await waitFor(() => expect(result.current.watcherStatus).not.toBeNull());

      const before = mockWsStreamClient.subscribeCallCount;
      // Not awaited on purpose: the clear happens at REPLACEMENT time, and the
      // returned promise settles only when the new session delivers its
      // targeted snapshot - which is after the window under test.
      void refreshGitSubscriptionWithFreshNonce({
        wsStreamClient: mockWsStreamClient,
        queryClient,
        hostId: "host1",
        runningDir: "/repo",
        ignoreWhitespace: false,
      });
      await waitFor(() =>
        expect(mockWsStreamClient.subscribeCallCount).toBeGreaterThan(before),
      );
      // Cleared at replacement time - BEFORE the new session's first frame,
      // which is the whole window this covers.
      await waitFor(() => expect(result.current.watcherStatus).toBeNull());
    });
  });

  describe("per-session schema version", () => {
    // `getMethodSchemaVersion` is CLIENT-WIDE per method:
    // `reconcileMethodSchemaVersion` (`ws-stream-client.ts:682-701`) walks the
    // owned sessions, takes the FIRST one carrying a version for that method,
    // and breaks. Two repos open on one host are two sessions on one client, so
    // a host restart that renegotiates one and not the other leaves the
    // client-wide value describing whichever session it reached first - and
    // every consumer reading that value gets the other repo's answer.
    //
    // Both tests below pin the SAME invariant from opposite directions: a frame
    // is parsed at the version ITS OWN session negotiated.

    function v12SnapshotFor(
      runningDir: string,
      fingerprint: string,
    ): GitSubscribeStatusEventV12 {
      return {
        type: "snapshot",
        runningDir,
        headSha: "head",
        branch: "main",
        files: [],
        fingerprint,
        nestedFingerprint: `nested-${fingerprint}`,
        repoMode: "normal",
        repoState: { kind: "clean" },
        submodules: [],
        pollStartedAtMs: 1_000,
        freshNonce: null,
      };
    }

    function v13SnapshotFor(
      runningDir: string,
      fingerprint: string,
      watcher: GitWatcherStatus,
    ): GitSubscribeStatusEventV13 {
      // Narrowed before the spread: the v1.2 helper is typed as the whole
      // union, and spreading it unnarrowed leaves `type` a union, so TS cannot
      // pick the member `watcher` belongs to.
      const base = v12SnapshotFor(runningDir, fingerprint);
      if (base.type !== "snapshot") throw new Error("expected a snapshot");
      return { ...base, watcher };
    }

    async function renderRepo(runningDir: string) {
      const rendered = renderHook(
        () =>
          useGitListChangedFilesSubscription({
            hostId: "host1",
            runningDir,
            ignoreWhitespace: false,
            enabled: true,
          }),
        { wrapper: createWrapper() },
      );
      const params = { hostId: "host1", runningDir, ignoreWhitespace: false };
      await waitFor(() => {
        expect(
          mockWsStreamClient.getSession("git.subscribeStatus", params),
        ).toBeDefined();
      });
      const session = mockWsStreamClient.getSession(
        "git.subscribeStatus",
        params,
      );
      if (session === undefined) {
        throw new Error(`Expected a session for ${runningDir}`);
      }
      return { result: rendered.result, session };
    }

    it("keeps a v1.3 frame's watcher health when the CLIENT-WIDE value reads 1.2", async () => {
      // The skew direction `tolerantV13Parse` cannot rescue, because the
      // fallback only ever degrades a v1.3 read DOWN. Here the client-wide
      // value is already the lower one: repo B reconnected against a rolled-back
      // host and answers reconciliation first, so repo A - still on 1.3 - has
      // its frames parsed with the v1.2 schema. That parse STRIPS `watcher`
      // (asserted directly by "ignores a watcher field arriving on a connection
      // negotiated at 1.2"), so repo A's degrade notice silently never appears:
      // the panel claims live updates while the watcher is off.
      mockWsStreamClient.methodSchemaVersion = { major: 1, minor: 2 };

      const repoB = await renderRepo("/repo-b");
      repoB.session.negotiatedSchemaVersion = { major: 1, minor: 2 };
      const repoA = await renderRepo("/repo-a");
      repoA.session.negotiatedSchemaVersion = { major: 1, minor: 3 };

      repoA.session.emitFrame(
        v13SnapshotFor("/repo-a", "parent-a", {
          state: "degraded-capacity",
          detail: "over budget",
        }),
        null,
      );

      await waitFor(() =>
        expect(repoA.result.current.data?.fingerprint).toBe("parent-a"),
      );
      expect(repoA.result.current.watcherStatus).toEqual({
        state: "degraded-capacity",
        detail: "over budget",
      });
      // Repo B is genuinely at 1.2 and must stay UNKNOWN - the fix routes each
      // frame to its own session's minor, it does not raise everyone to the max.
      expect(repoB.result.current.watcherStatus).toBeNull();
    });

    it("accepts a v1.2 frame when the CLIENT-WIDE value reads 1.3", async () => {
      // The mirror direction, and the one that GUARDS THE DELETION of
      // `tolerantV13Parse` rather than discriminating on its own: it passes
      // today only because that fallback degrades a failed v1.3 parse to v1.2.
      // Once delivery reads the delivering session it passes for the right
      // reason - repo B's frame is parsed with the v1.2 schema because repo B
      // negotiated 1.2 - which is what makes the fallback safe to remove.
      // Without either, the required `watcher` fails the parse and the frame is
      // dropped: repo B's changeset freezes until it reconnects.
      mockWsStreamClient.methodSchemaVersion = { major: 1, minor: 3 };

      const repoA = await renderRepo("/repo-a");
      repoA.session.negotiatedSchemaVersion = { major: 1, minor: 3 };
      const repoB = await renderRepo("/repo-b");
      repoB.session.negotiatedSchemaVersion = { major: 1, minor: 2 };

      repoB.session.emitFrame(v12SnapshotFor("/repo-b", "parent-b"), null);

      await waitFor(() =>
        expect(repoB.result.current.data?.fingerprint).toBe("parent-b"),
      );
      expect(repoB.result.current.watcherStatus).toBeNull();
    });

    it("scopes rich-slot ownership to the repo asking, not to the client", async () => {
      // The failure this closes has no fallback to soften it. The ownership
      // read used to take NO arguments at all while its caller is worktree-
      // scoped, so repo A at >= 1.1 disabled repo B's unary query - and with
      // B's own session at 1.0 the stream does not write B's rich slot either.
      // Both writers off: that panel has no writer at all.
      mockWsStreamClient.methodSchemaVersion = { major: 1, minor: 1 };

      const repoA = await renderRepo("/repo-a");
      repoA.session.negotiatedSchemaVersion = { major: 1, minor: 1 };
      const repoB = await renderRepo("/repo-b");
      repoB.session.negotiatedSchemaVersion = { major: 1, minor: 0 };

      const ownership = renderHook(
        () => ({
          a: useGitSubscriptionOwnsRichSlot({
            wsStreamClient: mockWsStreamClient,
            hostId: "host1",
            runningDir: "/repo-a",
            ignoreWhitespace: false,
          }),
          b: useGitSubscriptionOwnsRichSlot({
            wsStreamClient: mockWsStreamClient,
            hostId: "host1",
            runningDir: "/repo-b",
            ignoreWhitespace: false,
          }),
        }),
        { wrapper: createWrapper() },
      );

      await waitFor(() => expect(ownership.result.current.a).toBe(true));
      // The whole point: B answers for itself, and answers differently.
      expect(ownership.result.current.b).toBe(false);
    });

    it("hands the rich slot back when the stream terminates", async () => {
      // A terminated stream will never write the slot again, so the unary
      // query has to take it back. The client-wide value used to do this by
      // itself: closing a session removes it from `ownedSessions` and
      // reconciles the method's version away, leaving no owner. Reading the
      // entry's own session instead loses that for free - `StreamSession.close`
      // does NOT clear its negotiated version (only `resetForReconnect` does),
      // so a closed session keeps answering with the minor it last negotiated
      // and the slot stays disabled with nothing left to fill it.
      mockWsStreamClient.methodSchemaVersion = { major: 1, minor: 1 };
      const repo = await renderRepo("/repo-a");
      repo.session.negotiatedSchemaVersion = { major: 1, minor: 1 };

      const ownership = renderHook(
        () =>
          useGitSubscriptionOwnsRichSlot({
            wsStreamClient: mockWsStreamClient,
            hostId: "host1",
            runningDir: "/repo-a",
            ignoreWhitespace: false,
          }),
        { wrapper: createWrapper() },
      );
      await waitFor(() => expect(ownership.result.current).toBe(true));

      // Fatal domain frame -> `markTerminal`. Reconciliation drops the
      // client-wide value the same way it always did; the entry must not go on
      // answering from the session it just closed.
      // Reconciliation drops the client-wide value as the session leaves
      // `ownedSessions`, which happens DURING the close - so it is already gone
      // by the time anything re-reads. Setting it afterwards would leave the
      // store holding a snapshot taken while it was still 1.1.
      mockWsStreamClient.methodSchemaVersion = null;
      repo.session.emitFrame(
        { type: "error", message: "fatal git error", isFatal: true },
        null,
      );

      await waitFor(() => expect(ownership.result.current).toBe(false));
    });

    it("refuses a fresh-nonce refresh while the session is between connections", async () => {
      // The nonce gate is an ACTION taken against whatever session exists now,
      // so a stamp from a handshake that has already ended is not evidence for
      // it. A host that restarts and rolls back to v1.1 cannot echo a
      // `freshNonce`, and the caller treats a non-null return as "the stream is
      // handling it" and skips its unary fallback - so guessing high here costs
      // a real refresh and parks the user on the 10s timeout instead.
      mockWsStreamClient.methodSchemaVersion = { major: 1, minor: 2 };
      const repo = await renderRepo("/repo-a");
      repo.session.negotiatedSchemaVersion = { major: 1, minor: 2 };
      repo.session.emitFrame(v12SnapshotFor("/repo-a", "parent-a"), null);
      await waitFor(() =>
        expect(repo.result.current.data?.fingerprint).toBe("parent-a"),
      );

      // Mid-reconnect: `resetForReconnect` clears the session's negotiated
      // version, and reconciliation empties the client-wide one with it. Only
      // the delivered stamp still says 1.2.
      repo.session.negotiatedSchemaVersion = null;
      mockWsStreamClient.methodSchemaVersion = null;
      const before = mockWsStreamClient.subscribeCallCount;

      expect(
        refreshGitSubscriptionWithFreshNonce({
          wsStreamClient: mockWsStreamClient,
          queryClient,
          hostId: "host1",
          runningDir: "/repo-a",
          ignoreWhitespace: false,
        }),
      ).toBeNull();
      // No replacement was started, so nothing is left waiting on a nonce the
      // next peer may not be able to echo.
      expect(mockWsStreamClient.subscribeCallCount).toBe(before);
    });

    it("does not answer a TERMINATED stream from a live sibling's version", async () => {
      // Clearing the closed session and its stamp is not enough on its own: the
      // fallback below them is the client-wide value, and with repo B still
      // live at >= 1.1 that value is not empty - it is B's. Repo A would go on
      // reporting the stream owns its rich slot, with A's stream dead and no
      // way to refill it.
      //
      // The single-repo case hides this, because reconciliation empties the
      // client-wide value when the only session closes. A sibling keeps it
      // populated, which is exactly the skew this PR is about.
      mockWsStreamClient.methodSchemaVersion = { major: 1, minor: 1 };
      const repoA = await renderRepo("/repo-a");
      repoA.session.negotiatedSchemaVersion = { major: 1, minor: 1 };
      const repoB = await renderRepo("/repo-b");
      repoB.session.negotiatedSchemaVersion = { major: 1, minor: 1 };

      const ownership = renderHook(
        () =>
          useGitSubscriptionOwnsRichSlot({
            wsStreamClient: mockWsStreamClient,
            hostId: "host1",
            runningDir: "/repo-a",
            ignoreWhitespace: false,
          }),
        { wrapper: createWrapper() },
      );
      await waitFor(() => expect(ownership.result.current).toBe(true));

      // A dies; B lives, so the client-wide value STAYS at 1.1 throughout.
      repoA.session.emitFrame(
        { type: "error", message: "fatal git error", isFatal: true },
        null,
      );

      await waitFor(() => expect(ownership.result.current).toBe(false));
      expect(
        mockWsStreamClient.getMethodSchemaVersion("git.subscribeStatus"),
      ).toEqual({ major: 1, minor: 1 });
    });

    it("publishes this session's version at OPEN, before any frame", async () => {
      // The snapshot was already correct on read - `entrySchemaVersion` asks the
      // live session first - but nothing asked it. The entry channel only fires
      // on delivery, and `subscribeMethodSupport` fires only when the
      // CLIENT-WIDE value changes: with repo A already holding it at 1.1,
      // reconciliation keeps answering with A, so repo B negotiating 1.0 moves
      // nothing. B's hook kept its stale pre-handshake `true` until B's first
      // frame - and during a slow initial git scan that is a long time to sit
      // with the unary query disabled and a v1.0 stream that will never write
      // the rich slot.
      mockWsStreamClient.methodSchemaVersion = { major: 1, minor: 1 };
      const repoA = await renderRepo("/repo-a");
      repoA.session.negotiatedSchemaVersion = { major: 1, minor: 1 };
      const repoB = await renderRepo("/repo-b");

      const ownership = renderHook(
        () =>
          useGitSubscriptionOwnsRichSlot({
            wsStreamClient: mockWsStreamClient,
            hostId: "host1",
            runningDir: "/repo-b",
            ignoreWhitespace: false,
          }),
        { wrapper: createWrapper() },
      );
      // Pre-handshake, B defers to the client-wide value - which is A's.
      await waitFor(() => expect(ownership.result.current).toBe(true));

      // B's handshake settles at 1.0. The client-wide value does NOT move.
      repoB.session.negotiatedSchemaVersion = { major: 1, minor: 0 };
      repoB.session.emitStatus("open", null);

      // No frame has been delivered on B at any point in this test.
      await waitFor(() => expect(ownership.result.current).toBe(false));
      expect(repoB.result.current.data).toBeNull();
    });
  });
});
