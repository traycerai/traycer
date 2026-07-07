import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeDeleteStreamCallbacks } from "@traycer-clients/shared/host-transport/worktree-delete-stream-client";
import { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { runWorktreeCleanup } from "@/lib/epics/run-worktree-cleanup";

// Records constructor calls + callbacks per worktree path and counts client
// teardowns, so a test can drive terminal frames / connection drops and assert
// exactly one subscribe (construction) per path.
const streamMock = vi.hoisted(() => ({
  paths: [] as string[],
  callbacksByPath: new Map<string, WorktreeDeleteStreamCallbacks>(),
  closeCount: 0,
}));

vi.mock(
  "@traycer-clients/shared/host-transport/worktree-delete-stream-client",
  () => ({
    WorktreeDeleteStreamClient: class {
      constructor(options: {
        readonly worktreePath: string;
        readonly callbacks: WorktreeDeleteStreamCallbacks;
      }) {
        streamMock.paths.push(options.worktreePath);
        streamMock.callbacksByPath.set(options.worktreePath, options.callbacks);
      }
      close(): void {
        streamMock.closeCount += 1;
      }
    },
  }),
);

function callbacksFor(path: string): WorktreeDeleteStreamCallbacks {
  const callbacks = streamMock.callbacksByPath.get(path);
  if (callbacks === undefined) {
    throw new Error(`expected a delete stream for ${path}`);
  }
  return callbacks;
}

// A real `WsStreamClient` whose WS factory throws if dialled - the mocked stream
// wrapper never calls `.subscribe`, so this is only a non-null transport token.
function stubOpenStreamTransport(): (hostId: string) => DurableStreamTransport {
  return () => ({
    wsStreamClient: new WsStreamClient<HostStreamRpcRegistry>({
      registry: hostStreamRpcRegistry,
      endpoint: () => null,
      bearer: () => null,
      auth: null,
      webSocketFactory: {
        create: () => {
          throw new Error("stream WS factory must not be dialled in tests");
        },
      },
      dialTimeoutMs: 1,
      openAckTimeoutMs: 1,
      pingIntervalMs: 1,
      pongTimeoutMs: 1,
      initialBackoffMs: 1,
      maxBackoffMs: 1,
    }),
    close: vi.fn(),
  });
}

describe("runWorktreeCleanup", () => {
  beforeEach(() => {
    streamMock.paths = [];
    streamMock.callbacksByPath.clear();
    streamMock.closeCount = 0;
  });

  it("counts a completed delete as removed", async () => {
    const promise = runWorktreeCleanup(stubOpenStreamTransport(), "host-1", [
      "/wt/a",
    ]);
    callbacksFor("/wt/a").onComplete(true);
    await expect(promise).resolves.toEqual({ removed: ["/wt/a"], failed: [] });
  });

  it("counts a soft-failed (deleted:false) delete as failed", async () => {
    const promise = runWorktreeCleanup(stubOpenStreamTransport(), "host-1", [
      "/wt/a",
    ]);
    callbacksFor("/wt/a").onComplete(false);
    await expect(promise).resolves.toEqual({ removed: [], failed: ["/wt/a"] });
  });

  it("counts a host decline as failed", async () => {
    const promise = runWorktreeCleanup(stubOpenStreamTransport(), "host-1", [
      "/wt/a",
    ]);
    callbacksFor("/wt/a").onFailed("busy");
    await expect(promise).resolves.toEqual({ removed: [], failed: ["/wt/a"] });
  });

  // Regression: a recoverable drop (`reconnecting`, reason null) before any
  // terminal frame must fail fast - count the path failed, tear the session down
  // (exactly one subscribe, no reconnect re-run), and let the overall promise
  // settle so the summary toast + cache invalidation still fire.
  it("fails fast and settles when the stream drops before a terminal frame", async () => {
    const promise = runWorktreeCleanup(stubOpenStreamTransport(), "host-1", [
      "/wt/a",
    ]);
    callbacksFor("/wt/a").onConnectionStatus("reconnecting", null);
    await expect(promise).resolves.toEqual({ removed: [], failed: ["/wt/a"] });
    // Exactly one subscribe, and the session was torn down so the transport's
    // reconnect loop can't re-issue it.
    expect(streamMock.paths).toEqual(["/wt/a"]);
    expect(streamMock.closeCount).toBe(1);
  });

  it("treats a close before a terminal frame as a failure", async () => {
    const promise = runWorktreeCleanup(stubOpenStreamTransport(), "host-1", [
      "/wt/a",
    ]);
    callbacksFor("/wt/a").onConnectionStatus("closed", null);
    await expect(promise).resolves.toEqual({ removed: [], failed: ["/wt/a"] });
  });

  it("ignores normal startup statuses until a terminal frame arrives", async () => {
    const promise = runWorktreeCleanup(stubOpenStreamTransport(), "host-1", [
      "/wt/a",
    ]);
    callbacksFor("/wt/a").onConnectionStatus("connecting", null);
    callbacksFor("/wt/a").onConnectionStatus("open", null);
    callbacksFor("/wt/a").onComplete(true);
    await expect(promise).resolves.toEqual({ removed: ["/wt/a"], failed: [] });
  });

  it("settles a mixed batch of outcomes", async () => {
    const promise = runWorktreeCleanup(stubOpenStreamTransport(), "host-1", [
      "/wt/removed",
      "/wt/dropped",
    ]);
    callbacksFor("/wt/removed").onComplete(true);
    callbacksFor("/wt/dropped").onConnectionStatus("reconnecting", null);
    const outcome = await promise;
    expect(outcome.removed).toEqual(["/wt/removed"]);
    expect(outcome.failed).toEqual(["/wt/dropped"]);
  });
});
