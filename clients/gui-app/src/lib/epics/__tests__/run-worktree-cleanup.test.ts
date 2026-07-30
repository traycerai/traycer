import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeDeleteStreamCallbacks } from "@traycer-clients/shared/host-transport/worktree-delete-stream-client";
import type { WorktreeDeleteBatchStreamCallbacks } from "@traycer-clients/shared/host-transport/worktree-delete-batch-stream-client";
import type { WorktreeDeleteBatchTarget } from "@traycer/protocol/host/worktree-delete-batch-stream";
import { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import {
  runWorktreeCleanup,
  type WorktreeCleanupOutcome,
} from "@/lib/epics/run-worktree-cleanup";

// The current-host path: ONE `worktree.deleteBatchByPath` command per cleanup.
// Recording every construction is what lets a test assert the migration's core
// claim - N approved paths produce one command, not N streams.
const commandMock = vi.hoisted(() => ({
  commands: [] as Array<{
    readonly commandId: string;
    readonly source: string;
    readonly targets: ReadonlyArray<WorktreeDeleteBatchTarget>;
  }>,
  callbacks: null as WorktreeDeleteBatchStreamCallbacks | null,
  closeCount: 0,
}));

// The older-host fallback: the released per-target stream. Kept separate from
// `commandMock` so "the fallback ran" is never inferred from a command's frames.
const legacyMock = vi.hoisted(() => ({
  paths: [] as string[],
  callbacksByPath: new Map<string, WorktreeDeleteStreamCallbacks>(),
  /** Paths whose stream fails to open, driving `deleteOneWorktree`'s catch. */
  throwForPaths: new Set<string>(),
  closeCount: 0,
}));

// The renderer log sink. Making one specific message throw is how a test
// reaches the fallback's only unguarded region - see the rejection regression.
const loggerMock = vi.hoisted(() => ({
  throwForMessages: new Set<string>(),
  record: (message: string): void => {
    if (loggerMock.throwForMessages.has(message)) {
      throw new Error("log sink is gone");
    }
  },
}));

vi.mock("@/lib/logger", () => ({
  appLogger: {
    debug: (message: string) => loggerMock.record(message),
    info: (message: string) => loggerMock.record(message),
    warn: (message: string) => loggerMock.record(message),
    error: (message: string) => loggerMock.record(message),
  },
}));

vi.mock(
  "@traycer-clients/shared/host-transport/worktree-delete-batch-stream-client",
  () => ({
    WorktreeDeleteBatchStreamClient: class {
      constructor(options: {
        readonly commandId: string;
        readonly source: string;
        readonly targets: ReadonlyArray<WorktreeDeleteBatchTarget>;
        readonly callbacks: WorktreeDeleteBatchStreamCallbacks;
      }) {
        commandMock.commands.push({
          commandId: options.commandId,
          source: options.source,
          targets: options.targets,
        });
        commandMock.callbacks = options.callbacks;
      }
      close(): void {
        commandMock.closeCount += 1;
      }
    },
  }),
);

vi.mock(
  "@traycer-clients/shared/host-transport/worktree-delete-stream-client",
  () => ({
    WorktreeDeleteStreamClient: class {
      constructor(options: {
        readonly worktreePath: string;
        readonly callbacks: WorktreeDeleteStreamCallbacks;
      }) {
        legacyMock.paths.push(options.worktreePath);
        if (legacyMock.throwForPaths.has(options.worktreePath)) {
          throw new Error("could not open the delete stream");
        }
        legacyMock.callbacksByPath.set(options.worktreePath, options.callbacks);
      }
      close(): void {
        legacyMock.closeCount += 1;
      }
    },
  }),
);

function commandCallbacks(): WorktreeDeleteBatchStreamCallbacks {
  const callbacks = commandMock.callbacks;
  if (callbacks === null) throw new Error("expected a deletion command");
  return callbacks;
}

function legacyCallbacksFor(path: string): WorktreeDeleteStreamCallbacks {
  const callbacks = legacyMock.callbacksByPath.get(path);
  if (callbacks === undefined) {
    throw new Error(`expected a per-target delete stream for ${path}`);
  }
  return callbacks;
}

// A real `WsStreamClient` whose WS factory throws if dialled - the mocked stream
// wrappers never call `.subscribe`, so this is only a non-null transport token.
function stubOpenStreamTransport(): (hostId: string) => DurableStreamTransport {
  return () => ({
    wsStreamClient: new WsStreamClient<HostStreamRpcRegistry>({
      registry: hostStreamRpcRegistry,
      endpoint: () => null,
      bearer: () => null,
      auth: null,
      hostCredentialMint: null,
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

/** Drives the command to the point where the host has accepted it. */
function reachHost(): void {
  commandCallbacks().onConnectionStatus("open", null);
}

function runTaskCleanup(
  paths: ReadonlyArray<string>,
): Promise<WorktreeCleanupOutcome> {
  return runWorktreeCleanup(
    stubOpenStreamTransport(),
    "host-1",
    paths,
    "task_cleanup",
  );
}

/** Hands the whole cleanup to the older-host fan-out. */
function reportUnsupported(): void {
  commandCallbacks().onUnsupported();
}

beforeEach(() => {
  commandMock.commands = [];
  commandMock.callbacks = null;
  commandMock.closeCount = 0;
  legacyMock.paths = [];
  legacyMock.callbacksByPath.clear();
  legacyMock.throwForPaths.clear();
  legacyMock.closeCount = 0;
  loggerMock.throwForMessages.clear();
});

describe("runWorktreeCleanup on a current host", () => {
  it("opens ONE task_cleanup command covering every approved path", async () => {
    const promise = runTaskCleanup(["/wt/a", "/wt/b", "/wt/c"]);

    expect(commandMock.commands).toHaveLength(1);
    const command = commandMock.commands[0];
    expect(command.source).toBe("task_cleanup");
    // A validated UUID: the host's single-flight map rejects anything else, so
    // a shared constant here would collapse distinct cleanups onto one command.
    expect(command.commandId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    // `scripts: null` keeps the host reading each worktree's own committed
    // teardown scripts, as the pre-migration cleanup did.
    expect(command.targets).toEqual([
      { worktreePath: "/wt/a", scripts: null },
      { worktreePath: "/wt/b", scripts: null },
      { worktreePath: "/wt/c", scripts: null },
    ]);
    expect(legacyMock.paths).toEqual([]);

    commandCallbacks().onCommandComplete({
      requestedCount: 3,
      deletedCount: 0,
      failedCount: 3,
    });
    await promise;
  });

  it("preserves task_sweep as distinct durable command provenance", async () => {
    const promise = runWorktreeCleanup(
      stubOpenStreamTransport(),
      "host-1",
      ["/wt/sweep"],
      "task_sweep",
    );

    expect(commandMock.commands).toHaveLength(1);
    expect(commandMock.commands[0]?.source).toBe("task_sweep");
    commandCallbacks().onTargetComplete("/wt/sweep", true);
    commandCallbacks().onCommandComplete({
      requestedCount: 1,
      deletedCount: 1,
      failedCount: 0,
    });
    await expect(promise).resolves.toEqual({
      removed: ["/wt/sweep"],
      failed: [],
      uncertain: [],
    });
  });

  it("starts no command at all for an empty approved set", async () => {
    await expect(runTaskCleanup([])).resolves.toEqual({
      removed: [],
      failed: [],
      uncertain: [],
    });
    expect(commandMock.commands).toEqual([]);
    expect(legacyMock.paths).toEqual([]);
  });

  it("tallies per-target outcomes independently of one another", async () => {
    const promise = runTaskCleanup(["/wt/removed", "/wt/declined", "/wt/busy"]);
    reachHost();
    const callbacks = commandCallbacks();
    callbacks.onTargetComplete("/wt/removed", true);
    // A decline is `deleted: false`, not a thrown failure - both are failures
    // for the tally, and neither stops its siblings.
    callbacks.onTargetComplete("/wt/declined", false);
    callbacks.onTargetFailed("/wt/busy", "worktree is busy");
    callbacks.onCommandComplete({
      requestedCount: 3,
      deletedCount: 1,
      failedCount: 2,
    });

    await expect(promise).resolves.toEqual({
      removed: ["/wt/removed"],
      failed: ["/wt/declined", "/wt/busy"],
      uncertain: [],
    });
  });

  it("reports targets the host settled while detached as unconfirmed", async () => {
    const promise = runTaskCleanup(["/wt/seen", "/wt/missed"]);
    reachHost();
    commandCallbacks().onTargetComplete("/wt/seen", true);
    // The host does not replay per-target frames to a late observer, so
    // `command.complete` is terminal for anything still open.
    commandCallbacks().onCommandComplete({
      requestedCount: 2,
      deletedCount: 2,
      failedCount: 0,
    });

    await expect(promise).resolves.toEqual({
      removed: ["/wt/seen"],
      failed: [],
      uncertain: ["/wt/missed"],
    });
  });

  it("reports a drop after the command reached the host as unconfirmed, without replaying it", async () => {
    const promise = runTaskCleanup(["/wt/a", "/wt/b"]);
    reachHost();
    commandCallbacks().onTargetComplete("/wt/a", true);
    commandCallbacks().onConnectionStatus("reconnecting", null);

    await expect(promise).resolves.toEqual({
      removed: ["/wt/a"],
      failed: [],
      uncertain: ["/wt/b"],
    });
    // Detach, not cancel, and not restart: exactly one command was ever opened,
    // its session was released, and no destructive fallback was started behind
    // the user's back.
    expect(commandMock.commands).toHaveLength(1);
    expect(commandMock.closeCount).toBe(1);
    expect(legacyMock.paths).toEqual([]);
  });

  it("reports a drop BEFORE the command reached the host as failed", async () => {
    const promise = runTaskCleanup(["/wt/a"]);
    // No `open`: the subscribe frame never got to a live socket, so nothing was
    // attempted and there is nothing uncertain about it.
    commandCallbacks().onConnectionStatus("reconnecting", null);

    await expect(promise).resolves.toEqual({
      removed: [],
      failed: ["/wt/a"],
      uncertain: [],
    });
    expect(legacyMock.paths).toEqual([]);
  });

  it("reports a host-rejected command as failed", async () => {
    const promise = runTaskCleanup(["/wt/a", "/wt/b"]);
    reachHost();
    commandCallbacks().onCommandFailed("Worktree service is not ready.");

    await expect(promise).resolves.toEqual({
      removed: [],
      failed: ["/wt/a", "/wt/b"],
      uncertain: [],
    });
    // `command.failed` means no work ran or will run - re-running it per target
    // would be this client inventing a deletion the host declined.
    expect(legacyMock.paths).toEqual([]);
  });

  it("ignores normal startup statuses", async () => {
    const promise = runTaskCleanup(["/wt/a"]);
    commandCallbacks().onConnectionStatus("connecting", null);
    reachHost();
    commandCallbacks().onTargetComplete("/wt/a", true);
    commandCallbacks().onCommandComplete({
      requestedCount: 1,
      deletedCount: 1,
      failedCount: 0,
    });

    await expect(promise).resolves.toEqual({
      removed: ["/wt/a"],
      failed: [],
      uncertain: [],
    });
  });
});

describe("runWorktreeCleanup on an older host", () => {
  it("falls back to the bounded per-target fan-out", async () => {
    const promise = runTaskCleanup(["/wt/a", "/wt/b", "/wt/c"]);
    // Reported from the openAck compatibility check, BEFORE any subscribe frame
    // reached the host - which is what makes re-issuing the work safe.
    reportUnsupported();

    // Two at a time, exactly as the pre-migration cleanup ran.
    expect(legacyMock.paths).toEqual(["/wt/a", "/wt/b"]);
    legacyCallbacksFor("/wt/a").onComplete(true);
    await vi.waitFor(() => expect(legacyMock.paths).toHaveLength(3));

    legacyCallbacksFor("/wt/b").onComplete(false);
    legacyCallbacksFor("/wt/c").onFailed("busy");

    await expect(promise).resolves.toEqual({
      removed: ["/wt/a"],
      failed: ["/wt/b", "/wt/c"],
      uncertain: [],
    });
    // The batch attempt started nothing, so the fan-out is the only deletion.
    expect(commandMock.commands).toHaveLength(1);
    expect(commandMock.closeCount).toBe(1);
  });

  // Regression: a recoverable drop (`reconnecting`, reason null) before any
  // terminal frame must fail fast - count the path failed, tear the session down
  // (exactly one subscribe, no reconnect re-run), and let the overall promise
  // settle so the summary toast + cache invalidation still fire. Unchanged by
  // the migration: an older host has no command to keep running without us.
  it("fails fast and settles when a per-target stream drops", async () => {
    const promise = runTaskCleanup(["/wt/a"]);
    reportUnsupported();
    legacyCallbacksFor("/wt/a").onConnectionStatus("reconnecting", null);

    await expect(promise).resolves.toEqual({
      removed: [],
      failed: ["/wt/a"],
      uncertain: [],
    });
    expect(legacyMock.paths).toEqual(["/wt/a"]);
    expect(legacyMock.closeCount).toBe(1);
  });

  it("treats a per-target close before a terminal frame as a failure", async () => {
    const promise = runTaskCleanup(["/wt/a"]);
    reportUnsupported();
    legacyCallbacksFor("/wt/a").onConnectionStatus("closed", null);

    await expect(promise).resolves.toEqual({
      removed: [],
      failed: ["/wt/a"],
      uncertain: [],
    });
  });

  // The cleanup runner's standing invariant is that its promise ALWAYS settles:
  // the Tasks are already deleted by the time it runs, so a promise that hangs
  // costs the user their combined toast and the worktree cache invalidation,
  // silently.
  //
  // This drives the one region of the fan-out that can actually break it, end to
  // end rather than by stubbing a rejected promise: an open failure lands in
  // `deleteOneWorktree`'s catch, whose only statement before `finish` is the log
  // call. A log sink that throws there escapes the promise executor, so
  // `deleteOneWorktree` REJECTS - which rejects its worker, which rejects
  // `Promise.all`, which rejects `runFallbackCleanup`, which is the hand-off's
  // rejection branch.
  it("still settles when the per-target fan-out itself rejects", async () => {
    legacyMock.throwForPaths.add("/wt/a");
    loggerMock.throwForMessages.add(
      "[worktree-cleanup] failed to open delete stream",
    );

    const promise = runTaskCleanup(["/wt/a", "/wt/b"]);
    reportUnsupported();

    // Both paths went out before the fan-out came apart.
    expect(legacyMock.paths).toEqual(["/wt/a", "/wt/b"]);
    // Unconfirmed, not failed: the fan-out aborted at an unknown point, so a
    // removal that already landed is real and "couldn't be removed" would be a
    // false claim about the filesystem. And nothing is retried - an unknown
    // destructive outcome is exactly what must not be replayed.
    await expect(promise).resolves.toEqual({
      removed: [],
      failed: [],
      uncertain: ["/wt/a", "/wt/b"],
    });
  });

  it("ignores normal per-target startup statuses until a terminal frame arrives", async () => {
    const promise = runTaskCleanup(["/wt/a"]);
    reportUnsupported();
    legacyCallbacksFor("/wt/a").onConnectionStatus("connecting", null);
    legacyCallbacksFor("/wt/a").onConnectionStatus("open", null);
    legacyCallbacksFor("/wt/a").onComplete(true);

    await expect(promise).resolves.toEqual({
      removed: ["/wt/a"],
      failed: [],
      uncertain: [],
    });
  });
});
