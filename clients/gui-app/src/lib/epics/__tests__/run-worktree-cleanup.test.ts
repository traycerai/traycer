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
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";

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
  stopOwnersByPath: new Map<string, boolean>(),
  expectedHoldersRevisionByPath: new Map<string, string | undefined>(),
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
        readonly stopOwners: boolean;
        readonly expectedHoldersRevision: string | undefined;
        readonly callbacks: WorktreeDeleteStreamCallbacks;
      }) {
        legacyMock.paths.push(options.worktreePath);
        legacyMock.stopOwnersByPath.set(
          options.worktreePath,
          options.stopOwners,
        );
        legacyMock.expectedHoldersRevisionByPath.set(
          options.worktreePath,
          options.expectedHoldersRevision,
        );
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
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: () => null,
      bearer: () => null,
      auth: null,
      clock: null,
      hostCredentialMint: null,
      onHostCredentialState: null,
      evidence: NO_TRANSPORT_EVIDENCE,
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
  return runWorktreeCleanup(stubOpenStreamTransport(), {
    hostId: "host-1",
    paths,
    source: "task_cleanup",
    stopOwnersPaths: new Set(),
    expectedHoldersRevisionByPath: new Map(),
  });
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
  legacyMock.stopOwnersByPath.clear();
  legacyMock.expectedHoldersRevisionByPath.clear();
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
    const promise = runWorktreeCleanup(stubOpenStreamTransport(), {
      hostId: "host-1",
      paths: ["/wt/sweep"],
      source: "task_sweep",
      stopOwnersPaths: new Set(),
      expectedHoldersRevisionByPath: new Map(),
    });

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
      holdersChanged: [],
    });
  });

  it("starts no command at all for an empty approved set", async () => {
    await expect(runTaskCleanup([])).resolves.toEqual({
      removed: [],
      failed: [],
      uncertain: [],
      holdersChanged: [],
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
    callbacks.onTargetFailed("/wt/busy", "worktree is busy", undefined);
    callbacks.onCommandComplete({
      requestedCount: 3,
      deletedCount: 1,
      failedCount: 2,
    });

    await expect(promise).resolves.toEqual({
      removed: ["/wt/removed"],
      failed: ["/wt/declined", "/wt/busy"],
      uncertain: [],
      holdersChanged: [],
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
      holdersChanged: [],
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
      holdersChanged: [],
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
      holdersChanged: [],
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
      holdersChanged: [],
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
      holdersChanged: [],
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
    legacyCallbacksFor("/wt/c").onFailed(
      "busy",
      undefined,
      undefined,
      undefined,
    );

    await expect(promise).resolves.toEqual({
      removed: ["/wt/a"],
      failed: ["/wt/b", "/wt/c"],
      uncertain: [],
      holdersChanged: [],
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
      holdersChanged: [],
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
      holdersChanged: [],
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
      holdersChanged: [],
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
      holdersChanged: [],
    });
  });
});

describe("runWorktreeCleanup stopOwners paths", () => {
  it("sends in-use paths through deleteByPath with stopOwners and leaves others on the batch command", async () => {
    const promise = runWorktreeCleanup(stubOpenStreamTransport(), {
      hostId: "host-1",
      paths: ["/wt/idle", "/wt/busy"],
      source: "task_sweep",
      stopOwnersPaths: new Set(["/wt/busy"]),
      expectedHoldersRevisionByPath: new Map(),
    });

    expect(commandMock.commands).toHaveLength(0);
    expect(legacyMock.paths).toEqual(["/wt/busy"]);
    expect(legacyMock.stopOwnersByPath.get("/wt/busy")).toBe(true);
    legacyCallbacksFor("/wt/busy").onComplete(true);
    await vi.waitFor(() => expect(commandMock.commands).toHaveLength(1));
    expect(commandMock.commands[0]?.targets).toEqual([
      { worktreePath: "/wt/idle", scripts: null },
    ]);

    commandCallbacks().onTargetComplete("/wt/idle", true);
    commandCallbacks().onCommandComplete({
      requestedCount: 1,
      deletedCount: 1,
      failedCount: 0,
    });

    await expect(promise).resolves.toEqual({
      removed: ["/wt/idle", "/wt/busy"],
      failed: [],
      uncertain: [],
      holdersChanged: [],
    });
  });

  it("reports a drop after a forced deleteByPath reached the host as unconfirmed", async () => {
    const promise = runWorktreeCleanup(stubOpenStreamTransport(), {
      hostId: "host-1",
      paths: ["/wt/busy"],
      source: "task_sweep",
      stopOwnersPaths: new Set(["/wt/busy"]),
      expectedHoldersRevisionByPath: new Map(),
    });

    expect(commandMock.commands).toHaveLength(0);
    expect(legacyMock.paths).toEqual(["/wt/busy"]);
    legacyCallbacksFor("/wt/busy").onConnectionStatus("open", null);
    legacyCallbacksFor("/wt/busy").onConnectionStatus("reconnecting", null);

    await expect(promise).resolves.toEqual({
      removed: [],
      failed: [],
      uncertain: ["/wt/busy"],
      holdersChanged: [],
    });
    expect(legacyMock.closeCount).toBe(1);
  });

  it("returns HOLDERS_CHANGED without starting the batch delete", async () => {
    const promise = runWorktreeCleanup(stubOpenStreamTransport(), {
      hostId: "host-1",
      paths: ["/wt/idle", "/wt/busy"],
      source: "task_sweep",
      stopOwnersPaths: new Set(["/wt/busy"]),
      expectedHoldersRevisionByPath: new Map([
        [
          "/wt/busy",
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ],
      ]),
    });

    expect(legacyMock.paths).toEqual(["/wt/busy"]);
    legacyCallbacksFor("/wt/busy").onFailed(
      "Holders changed",
      [
        {
          ownerRef: {
            epicId: "epic-1",
            ownerKind: "chat",
            ownerId: "chat-1",
          },
          holdKind: "chat-turn",
          activity: "working",
          label: "new actor",
          holderId: "epic-1:chat:chat-1",
        },
      ],
      "WORKTREE_HOLDERS_CHANGED",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );

    await expect(promise).resolves.toEqual({
      removed: [],
      failed: [],
      uncertain: [],
      holdersChanged: [
        {
          worktreePath: "/wt/busy",
          holders: [
            {
              ownerRef: {
                epicId: "epic-1",
                ownerKind: "chat",
                ownerId: "chat-1",
              },
              holdKind: "chat-turn",
              activity: "working",
              label: "new actor",
              holderId: "epic-1:chat:chat-1",
            },
          ],
          holdersRevision:
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
      ],
    });
    expect(commandMock.commands).toHaveLength(0);
  });

  it("keeps settled force outcomes and does not start the idle batch on mixed HOLDERS_CHANGED", async () => {
    const digest =
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const promise = runWorktreeCleanup(stubOpenStreamTransport(), {
      hostId: "host-1",
      paths: ["/wt/idle", "/wt/ok", "/wt/busy"],
      source: "task_sweep",
      stopOwnersPaths: new Set(["/wt/ok", "/wt/busy"]),
      expectedHoldersRevisionByPath: new Map([
        ["/wt/ok", digest],
        ["/wt/busy", digest],
      ]),
    });

    expect(legacyMock.paths.sort()).toEqual(["/wt/busy", "/wt/ok"]);
    expect(commandMock.commands).toHaveLength(0);
    legacyCallbacksFor("/wt/ok").onComplete(true);
    legacyCallbacksFor("/wt/busy").onFailed(
      "Holders changed",
      [
        {
          ownerRef: {
            epicId: "epic-1",
            ownerKind: "chat",
            ownerId: "chat-1",
          },
          holdKind: "chat-turn",
          activity: "working",
          label: "new actor",
          holderId: "epic-1:chat:chat-1",
        },
      ],
      "WORKTREE_HOLDERS_CHANGED",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );

    await expect(promise).resolves.toMatchObject({
      removed: ["/wt/ok"],
      failed: [],
      uncertain: [],
      holdersChanged: [{ worktreePath: "/wt/busy" }],
    });
    expect(commandMock.commands).toHaveLength(0);
  });

  it("forwards a valid holdersRevision with stopOwners", async () => {
    const digest =
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const promise = runWorktreeCleanup(stubOpenStreamTransport(), {
      hostId: "host-1",
      paths: ["/wt/busy"],
      source: "task_sweep",
      stopOwnersPaths: new Set(["/wt/busy"]),
      expectedHoldersRevisionByPath: new Map([["/wt/busy", digest]]),
    });
    expect(legacyMock.stopOwnersByPath.get("/wt/busy")).toBe(true);
    expect(legacyMock.expectedHoldersRevisionByPath.get("/wt/busy")).toBe(
      digest,
    );
    legacyCallbacksFor("/wt/busy").onComplete(true);
    await expect(promise).resolves.toEqual({
      removed: ["/wt/busy"],
      failed: [],
      uncertain: [],
      holdersChanged: [],
    });
  });

  it("omits expectedHoldersRevision when stopOwners is false", async () => {
    const promise = runTaskCleanup(["/wt/a"]);
    reportUnsupported();
    expect(legacyMock.stopOwnersByPath.get("/wt/a")).toBe(false);
    expect(
      legacyMock.expectedHoldersRevisionByPath.get("/wt/a"),
    ).toBeUndefined();
    legacyCallbacksFor("/wt/a").onComplete(true);
    await expect(promise).resolves.toEqual({
      removed: ["/wt/a"],
      failed: [],
      uncertain: [],
      holdersChanged: [],
    });
  });

  it("omits an invalid holdersRevision even with stopOwners", async () => {
    const promise = runWorktreeCleanup(stubOpenStreamTransport(), {
      hostId: "host-1",
      paths: ["/wt/busy"],
      source: "task_sweep",
      stopOwnersPaths: new Set(["/wt/busy"]),
      expectedHoldersRevisionByPath: new Map([["/wt/busy", "not-a-digest"]]),
    });
    expect(legacyMock.stopOwnersByPath.get("/wt/busy")).toBe(true);
    expect(
      legacyMock.expectedHoldersRevisionByPath.get("/wt/busy"),
    ).toBeUndefined();
    legacyCallbacksFor("/wt/busy").onComplete(true);
    await expect(promise).resolves.toEqual({
      removed: ["/wt/busy"],
      failed: [],
      uncertain: [],
      holdersChanged: [],
    });
  });
});
