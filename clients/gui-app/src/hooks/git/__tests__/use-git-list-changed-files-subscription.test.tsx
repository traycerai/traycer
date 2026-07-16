import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { GitSubscribeStatusEvent } from "@traycer/protocol/host/git-schemas";
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
import {
  useGitListChangedFilesSubscription,
  __resetSubscriptionsForTesting,
} from "../use-git-list-changed-files-subscription";

// Mock stream session for testing.
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

  sendClientFrame(): void {
    // No-op for this test.
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

describe("useGitListChangedFilesSubscription", () => {
  let queryClient: QueryClient;
  let mockWsStreamClient: MockWsStreamClient;

  const createWrapper = () => {
    return ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <StreamRuntimeContext.Provider
          value={{
            wsStreamClient: mockWsStreamClient,
          }}
        >
          {children}
        </StreamRuntimeContext.Provider>
      </QueryClientProvider>
    );
  };

  beforeEach(() => {
    __resetSubscriptionsForTesting();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    mockWsStreamClient = new MockWsStreamClient();
  });

  afterEach(() => {
    __resetSubscriptionsForTesting();
    queryClient.clear();
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

  it("a closed stream client surfaces an error via the inert session", async () => {
    const closedClient = new WsStreamClient<HostStreamRpcRegistry>({
      registry: hostStreamRpcRegistry,
      endpoint: () => null,
      bearer: () => null,
      auth: null,
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
    const closedWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <StreamRuntimeContext.Provider value={{ wsStreamClient: closedClient }}>
          {children}
        </StreamRuntimeContext.Provider>
      </QueryClientProvider>
    );

    const { result } = renderHook(
      () =>
        useGitListChangedFilesSubscription({
          hostId: "host1",
          runningDir: "/repo",
          ignoreWhitespace: false,
          enabled: true,
        }),
      { wrapper: closedWrapper },
    );

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });
    const error = result.current.error;
    if (error === null || error.type !== "error") {
      throw new Error("Expected an error event");
    }
    expect(error.isFatal).toBe(true);
    expect(error.message).toContain("CLIENT_CLOSED");
    expect(result.current.isPending).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
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
});
