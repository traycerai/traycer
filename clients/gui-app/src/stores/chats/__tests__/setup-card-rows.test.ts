import { beforeEach, describe, expect, it } from "vitest";
import type { ChatEvent } from "@traycer/protocol/persistence/epic/schemas";
import {
  buildSetupCardRows,
  type SetupCardBinding,
} from "@/stores/chats/setup-card-rows";

const BINDING: SetupCardBinding = {
  epicId: "epic-1",
  ownerId: "owner-1",
  ownerKind: "chat",
};

let eventCounter = 0;

beforeEach(() => {
  eventCounter = 0;
});

/**
 * Minimal `setup.*` event factory. `timestamp` defaults to a monotonically
 * increasing counter so array order and timestamp order agree unless a test
 * pins `timestamp` explicitly to exercise out-of-order handling.
 */
function setupEvent(
  type: ChatEvent["type"],
  metadata: Record<string, unknown>,
  timestamp: number | null,
): ChatEvent {
  eventCounter += 1;
  return {
    eventId: `event-${eventCounter}`,
    type,
    timestamp: timestamp ?? eventCounter,
    clientActionId: null,
    actor: null,
    message: null,
    turnId: null,
    messageId: null,
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: "info",
    metadata,
  };
}

function onlyRow(events: ReadonlyArray<ChatEvent>) {
  const rows = buildSetupCardRows(events, BINDING);
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe("buildSetupCardRows", () => {
  it("returns [] when there are no setup events", () => {
    const events = [
      setupEvent("turn.started", {}, null),
      setupEvent("turn.completed", {}, null),
    ];
    expect(buildSetupCardRows(events, BINDING)).toEqual([]);
  });

  it("ignores non-setup events while deriving", () => {
    const row = onlyRow([
      setupEvent("turn.started", {}, null),
      setupEvent("setup.running", { workspacePath: "/repo" }, null),
      setupEvent("turn.completed", {}, null),
    ]);
    expect(row.model.workspaces).toHaveLength(1);
    expect(row.model.workspaces[0].state).toBe("setting-up");
  });

  it("maps setup.creating to the creating state (git worktree add in flight)", () => {
    const row = onlyRow([
      setupEvent(
        "setup.creating",
        { workspacePath: "/repo", branch: "feat" },
        null,
      ),
    ]);
    expect(row.model.workspaces[0].state).toBe("creating");
    expect(row.model.aggregate.state).toBe("creating");
    expect(row.isActive).toBe(true);
  });

  it("carries the triggeringMessageId from the setup.creating event", () => {
    const row = onlyRow([
      setupEvent(
        "setup.creating",
        {
          workspacePath: "/repo",
          branch: "feat",
          triggeringMessageId: "msg-1",
        },
        null,
      ),
      setupEvent(
        "setup.running",
        { workspacePath: "/repo", terminalSessionId: "t1" },
        null,
      ),
    ]);
    // The id rides only on the creating event; a later running event in the same
    // window doesn't carry it, but the row still surfaces it (read from creating).
    expect(row.triggeringMessageId).toBe("msg-1");
  });

  it("has a null triggeringMessageId for a window with no setup.creating (genesis)", () => {
    const row = onlyRow([
      setupEvent("setup.running", { workspacePath: "/repo" }, null),
      setupEvent("setup.succeeded", { workspacePath: "/repo" }, null),
    ]);
    expect(row.triggeringMessageId).toBeNull();
  });

  it("supersedes creating with running (creating -> setting-up)", () => {
    const row = onlyRow([
      setupEvent(
        "setup.creating",
        { workspacePath: "/repo", branch: "feat" },
        null,
      ),
      setupEvent(
        "setup.running",
        { workspacePath: "/repo", terminalSessionId: "t1" },
        null,
      ),
    ]);
    expect(row.model.workspaces[0].state).toBe("setting-up");
  });

  it("opens a fresh window when setup.creating arrives after a succeeded worktree", () => {
    const rows = buildSetupCardRows(
      [
        setupEvent(
          "setup.running",
          { workspacePath: "/repo", terminalSessionId: "t1" },
          1,
        ),
        setupEvent("setup.succeeded", { workspacePath: "/repo" }, 2),
        setupEvent(
          "setup.creating",
          { workspacePath: "/repo", branch: "feat-2" },
          3,
        ),
      ],
      BINDING,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].model.workspaces[0].state).toBe("ready");
    expect(rows[0].isActive).toBe(false);
    expect(rows[1].model.workspaces[0].state).toBe("creating");
    expect(rows[1].isActive).toBe(true);
  });

  it("carries the binding identity onto the aggregate", () => {
    const row = onlyRow([
      setupEvent("setup.running", { workspacePath: "/repo" }, null),
    ]);
    expect(row.model.aggregate).toMatchObject({
      epicId: "epic-1",
      ownerId: "owner-1",
      ownerKind: "chat",
    });
  });

  it("carries worktreePath and branch onto the workspace (inherited newest-first)", () => {
    const row = onlyRow([
      setupEvent(
        "setup.running",
        {
          workspacePath: "/work/app",
          worktreePath: "/wt/app/feature",
          branch: "feature",
          terminalSessionId: "term-1",
        },
        null,
      ),
      // An older `setup.succeeded` may omit worktreePath/branch; the workspace
      // must inherit them newest-first from the `running` event.
      setupEvent("setup.succeeded", { workspacePath: "/work/app" }, null),
    ]);
    expect(row.model.workspaces[0].worktreePath).toBe("/wt/app/feature");
    expect(row.model.workspaces[0].branch).toBe("feature");
  });

  it("leaves worktreePath/branch null when no event carries them", () => {
    const row = onlyRow([
      setupEvent("setup.running", { workspacePath: "/work/app" }, null),
    ]);
    expect(row.model.workspaces[0].worktreePath).toBeNull();
    expect(row.model.workspaces[0].branch).toBeNull();
  });

  it("projects a single-repo running -> ready lifecycle", () => {
    const row = onlyRow([
      setupEvent(
        "setup.running",
        { workspacePath: "/work/my-feature", terminalSessionId: "term-1" },
        null,
      ),
      setupEvent(
        "setup.succeeded",
        { workspacePath: "/work/my-feature" },
        null,
      ),
    ]);

    expect(row.model.aggregate.state).toBe("ready");
    expect(row.model.workspaces).toHaveLength(1);
    expect(row.model.workspaces[0]).toEqual({
      workspacePath: "/work/my-feature",
      label: "my-feature",
      state: "ready",
      setupExitCode: null,
      // succeeded carries no terminal id; it is inherited from running.
      terminalSessionId: "term-1",
      // These events carry no worktreePath/branch metadata, so both are null.
      worktreePath: null,
      branch: null,
    });
  });

  it("derives the folder-name label from the workspace path", () => {
    const row = onlyRow([
      setupEvent("setup.running", { workspacePath: "/a/b/c/api" }, null),
    ]);
    expect(row.model.workspaces[0].label).toBe("api");
  });

  it("surfaces the exit code and terminal id on a failure", () => {
    const row = onlyRow([
      setupEvent(
        "setup.running",
        { workspacePath: "/repo", terminalSessionId: "term-1" },
        null,
      ),
      setupEvent(
        "setup.failed",
        {
          workspacePath: "/repo",
          setupExitCode: 17,
          terminalSessionId: "term-1",
        },
        null,
      ),
    ]);
    expect(row.model.aggregate.state).toBe("failed");
    expect(row.model.workspaces[0]).toMatchObject({
      state: "failed",
      setupExitCode: 17,
      terminalSessionId: "term-1",
    });
  });

  it("keeps a terminal id carried by a final succeeded event", () => {
    const row = onlyRow([
      setupEvent(
        "setup.succeeded",
        {
          workspacePath: "/repo",
          worktreePath: "/worktrees/repo/feature",
          branch: "feature",
          terminalSessionId: "term-ready",
        },
        null,
      ),
    ]);

    expect(row.model.workspaces[0]).toMatchObject({
      state: "ready",
      terminalSessionId: "term-ready",
      worktreePath: "/worktrees/repo/feature",
      branch: "feature",
    });
  });

  it("clears the exit code once a workspace is no longer failed", () => {
    const row = onlyRow([
      setupEvent(
        "setup.failed",
        { workspacePath: "/repo", setupExitCode: 1 },
        null,
      ),
      setupEvent("setup.running", { workspacePath: "/repo" }, null),
      setupEvent("setup.succeeded", { workspacePath: "/repo" }, null),
    ]);
    expect(row.model.workspaces[0].state).toBe("ready");
    expect(row.model.workspaces[0].setupExitCode).toBeNull();
  });

  it("treats a retry's later setup.running as superseding an earlier failure", () => {
    const row = onlyRow([
      setupEvent(
        "setup.failed",
        { workspacePath: "/repo", setupExitCode: 2 },
        null,
      ),
      setupEvent(
        "setup.running",
        { workspacePath: "/repo", terminalSessionId: "term-retry" },
        null,
      ),
    ]);
    expect(row.model.workspaces[0].state).toBe("setting-up");
    expect(row.model.workspaces[0].terminalSessionId).toBe("term-retry");
    expect(row.model.aggregate.state).toBe("setting-up");
  });

  it("projects a cancelled workspace", () => {
    const row = onlyRow([
      setupEvent("setup.running", { workspacePath: "/repo" }, null),
      setupEvent(
        "setup.cancelled",
        { workspacePath: "/repo", terminalSessionId: "term-1" },
        null,
      ),
    ]);
    expect(row.model.aggregate.state).toBe("cancelled");
    expect(row.model.workspaces[0].state).toBe("cancelled");
  });

  it("consolidates multi-repo into one row with a per-workspace entry", () => {
    const row = onlyRow([
      setupEvent("setup.running", { workspacePath: "/api" }, null),
      setupEvent("setup.running", { workspacePath: "/web" }, null),
      setupEvent("setup.running", { workspacePath: "/worker" }, null),
      setupEvent("setup.succeeded", { workspacePath: "/api" }, null),
      setupEvent(
        "setup.failed",
        { workspacePath: "/web", setupExitCode: 3 },
        null,
      ),
      setupEvent("setup.succeeded", { workspacePath: "/worker" }, null),
    ]);

    // First-seen order is preserved.
    expect(row.model.workspaces.map((w) => w.workspacePath)).toEqual([
      "/api",
      "/web",
      "/worker",
    ]);
    expect(row.model.workspaces.map((w) => w.state)).toEqual([
      "ready",
      "failed",
      "ready",
    ]);
    // Any failure dominates the rollup.
    expect(row.model.aggregate.state).toBe("failed");
    expect(row.model.workspaces[1].setupExitCode).toBe(3);
  });

  it("rolls up to setting-up when no failure but work is in flight", () => {
    const row = onlyRow([
      setupEvent("setup.succeeded", { workspacePath: "/api" }, null),
      setupEvent("setup.running", { workspacePath: "/web" }, null),
    ]);
    expect(row.model.aggregate.state).toBe("setting-up");
  });

  it("rolls up to cancelled only when no failure and nothing in flight", () => {
    const row = onlyRow([
      setupEvent("setup.succeeded", { workspacePath: "/api" }, null),
      setupEvent("setup.cancelled", { workspacePath: "/web" }, null),
    ]);
    expect(row.model.aggregate.state).toBe("cancelled");
  });

  it("rolls up to ready only when every workspace is ready", () => {
    const row = onlyRow([
      setupEvent("setup.succeeded", { workspacePath: "/api" }, null),
      setupEvent("setup.succeeded", { workspacePath: "/web" }, null),
    ]);
    expect(row.model.aggregate.state).toBe("ready");
  });

  it("prefers in-flight over cancelled in the rollup", () => {
    const row = onlyRow([
      setupEvent("setup.cancelled", { workspacePath: "/api" }, null),
      setupEvent("setup.running", { workspacePath: "/web" }, null),
    ]);
    expect(row.model.aggregate.state).toBe("setting-up");
  });

  it("anchors createdAt at the earliest setup-event timestamp", () => {
    const row = onlyRow([
      setupEvent("setup.running", { workspacePath: "/api" }, 5_000),
      setupEvent("setup.running", { workspacePath: "/web" }, 3_000),
      setupEvent("setup.succeeded", { workspacePath: "/api" }, 8_000),
    ]);
    expect(row.createdAt).toBe(3_000);
    expect(row.model.createdAt).toBe(3_000);
  });

  it("anchors createdAt deterministically even when events arrive out of timestamp order", () => {
    // Latest STATE is still by array order (the failed event arrives last in
    // the log), but the anchor is the minimum timestamp regardless of order.
    const row = onlyRow([
      setupEvent("setup.running", { workspacePath: "/repo" }, 9_000),
      setupEvent(
        "setup.failed",
        { workspacePath: "/repo", setupExitCode: 1 },
        2_000,
      ),
    ]);
    expect(row.createdAt).toBe(2_000);
    expect(row.model.workspaces[0].state).toBe("failed");
  });

  it("omits the terminal id when no event ever linked one", () => {
    const row = onlyRow([
      setupEvent("setup.running", { workspacePath: "/repo" }, null),
      setupEvent(
        "setup.failed",
        { workspacePath: "/repo", setupExitCode: 1 },
        null,
      ),
    ]);
    expect(row.model.workspaces[0].terminalSessionId).toBeNull();
  });

  it("splits a same-host re-bind (worktree.missing) into two rows, keeping the first ready", () => {
    const rows = buildSetupCardRows(
      [
        setupEvent(
          "setup.running",
          { workspacePath: "/repo", terminalSessionId: "term-1" },
          1_000,
        ),
        setupEvent("setup.succeeded", { workspacePath: "/repo" }, 2_000),
        setupEvent("worktree.missing", { workspacePath: "/repo" }, 3_000),
        setupEvent(
          "setup.running",
          { workspacePath: "/repo", terminalSessionId: "term-2" },
          4_000,
        ),
        setupEvent("setup.succeeded", { workspacePath: "/repo" }, 5_000),
      ],
      BINDING,
    );

    expect(rows).toHaveLength(2);
    // First lifecycle stays ready - it is NOT flipped back to setting-up.
    expect(rows[0].createdAt).toBe(1_000);
    expect(rows[0].model.aggregate.state).toBe("ready");
    expect(rows[0].model.workspaces[0].terminalSessionId).toBe("term-1");
    // Second lifecycle is anchored at the re-bind moment with its own terminal.
    expect(rows[1].createdAt).toBe(4_000);
    expect(rows[1].model.aggregate.state).toBe("ready");
    expect(rows[1].model.workspaces[0].terminalSessionId).toBe("term-2");
  });

  it("scopes each lifecycle to its own workspace when a re-bind targets a different path", () => {
    const rows = buildSetupCardRows(
      [
        setupEvent("setup.running", { workspacePath: "/old" }, 1_000),
        setupEvent("setup.succeeded", { workspacePath: "/old" }, 2_000),
        setupEvent("worktree.missing", { workspacePath: "/old" }, 3_000),
        setupEvent("setup.running", { workspacePath: "/new" }, 4_000),
        setupEvent("setup.succeeded", { workspacePath: "/new" }, 5_000),
      ],
      BINDING,
    );

    expect(rows).toHaveLength(2);
    expect(rows[0].model.workspaces.map((w) => w.workspacePath)).toEqual([
      "/old",
    ]);
    expect(rows[1].model.workspaces.map((w) => w.workspacePath)).toEqual([
      "/new",
    ]);
  });

  it("splits a defensive ready -> running re-bind even without worktree.missing", () => {
    const rows = buildSetupCardRows(
      [
        setupEvent("setup.running", { workspacePath: "/repo" }, 1_000),
        setupEvent("setup.succeeded", { workspacePath: "/repo" }, 2_000),
        // No worktree.missing, but a fresh running after succeeded is a re-bind.
        setupEvent("setup.running", { workspacePath: "/repo" }, 3_000),
      ],
      BINDING,
    );

    expect(rows).toHaveLength(2);
    expect(rows[0].model.aggregate.state).toBe("ready");
    expect(rows[1].model.aggregate.state).toBe("setting-up");
    expect(rows[1].createdAt).toBe(3_000);
  });

  it("splits a separate later create send into its own window (progressed past creating)", () => {
    const rows = buildSetupCardRows(
      [
        // One create send runs a worktree for /api to completion...
        setupEvent("setup.creating", { workspacePath: "/api" }, 1_000),
        setupEvent("setup.running", { workspacePath: "/api" }, 2_000),
        setupEvent("setup.succeeded", { workspacePath: "/api" }, 3_000),
        // ...then a SEPARATE later send creates a worktree for a different repo.
        // Its `setup.creating` lands after the first window progressed past its
        // creating phase, so it opens its own card instead of folding in.
        setupEvent("setup.creating", { workspacePath: "/web" }, 4_000),
        setupEvent("setup.running", { workspacePath: "/web" }, 5_000),
      ],
      BINDING,
    );

    expect(rows).toHaveLength(2);
    expect(rows[0].model.workspaces.map((w) => w.workspacePath)).toEqual([
      "/api",
    ]);
    expect(rows[0].createdAt).toBe(1_000);
    expect(rows[1].model.workspaces.map((w) => w.workspacePath)).toEqual([
      "/web",
    ]);
    // The second card anchors at its OWN creation moment (near its triggering
    // send), not the first lifecycle's genesis.
    expect(rows[1].createdAt).toBe(4_000);
  });

  it("consolidates a multi-worktree single send whose creatings arrive together", () => {
    const row = onlyRow([
      // One send creating two worktrees: both `setup.creating` events arrive
      // BEFORE either `setup.running`, so the window has not progressed past its
      // creating phase and they stay in one consolidated card.
      setupEvent("setup.creating", { workspacePath: "/api" }, 1_000),
      setupEvent("setup.creating", { workspacePath: "/web" }, 2_000),
      setupEvent("setup.running", { workspacePath: "/api" }, 3_000),
      setupEvent("setup.running", { workspacePath: "/web" }, 4_000),
    ]);

    expect(row.model.workspaces.map((w) => w.workspacePath)).toEqual([
      "/api",
      "/web",
    ]);
    expect(row.createdAt).toBe(1_000);
  });

  it("flags a still-running window active", () => {
    const row = onlyRow([
      setupEvent("setup.running", { workspacePath: "/repo" }, 1_000),
    ]);
    expect(row.isActive).toBe(true);
    // The model mirrors the row's `isActive` so the component (which only sees
    // the model) can render the live affordances.
    expect(row.model.isActive).toBe(true);
    expect(row.model.aggregate.state).toBe("setting-up");
  });

  it("flags a worktree.missing-closed window inactive even when stranded at setting-up", () => {
    // The worktree vanished mid-setup: the host emits no terminal setup event,
    // so the row stays `setting-up`. But the window is closed - it is NOT the
    // live lifecycle and must read inactive so it can never gate a later turn,
    // and the card must render it statically (no spinner / ticking timer).
    const row = onlyRow([
      setupEvent("setup.running", { workspacePath: "/repo" }, 1_000),
      setupEvent("worktree.missing", { workspacePath: "/repo" }, 2_000),
    ]);
    expect(row.isActive).toBe(false);
    expect(row.model.isActive).toBe(false);
    expect(row.model.aggregate.state).toBe("setting-up");
  });

  it("flags only the live re-bind window active across lifecycles", () => {
    const rows = buildSetupCardRows(
      [
        setupEvent("setup.running", { workspacePath: "/repo" }, 1_000),
        setupEvent("setup.succeeded", { workspacePath: "/repo" }, 2_000),
        setupEvent("worktree.missing", { workspacePath: "/repo" }, 3_000),
        setupEvent("setup.running", { workspacePath: "/repo" }, 4_000),
      ],
      BINDING,
    );
    // Historical (closed) window inactive; the live re-bind window active.
    expect(rows.map((row) => row.isActive)).toEqual([false, true]);
  });

  it("keeps a failed -> running retry in the same row (no boundary)", () => {
    // A retry (no worktree.missing, workspace not succeeded) supersedes in place.
    const row = onlyRow([
      setupEvent(
        "setup.failed",
        { workspacePath: "/repo", setupExitCode: 2 },
        1_000,
      ),
      setupEvent("setup.running", { workspacePath: "/repo" }, 2_000),
    ]);
    expect(row.createdAt).toBe(1_000);
    expect(row.model.workspaces).toHaveLength(1);
    expect(row.model.workspaces[0].state).toBe("setting-up");
  });

  it("emits no row for a path-less SETUP_AWAIT_FAILED failure", () => {
    const rows = buildSetupCardRows(
      [setupEvent("setup.failed", { code: "SETUP_AWAIT_FAILED" }, null)],
      BINDING,
    );
    expect(rows).toEqual([]);
  });

  it("ignores a path-less failure interleaved with a real workspace lifecycle", () => {
    const row = onlyRow([
      setupEvent(
        "setup.running",
        { workspacePath: "/repo", terminalSessionId: "term-1" },
        null,
      ),
      setupEvent("setup.failed", { code: "SETUP_AWAIT_FAILED" }, null),
      setupEvent("setup.succeeded", { workspacePath: "/repo" }, null),
    ]);
    // The path-less event never created a keyless/empty-path workspace entry.
    expect(row.model.workspaces).toHaveLength(1);
    expect(row.model.workspaces[0].workspacePath).toBe("/repo");
    expect(row.model.workspaces[0].state).toBe("ready");
  });

  it("lets failure dominate setting-up within one lifecycle window", () => {
    const row = onlyRow([
      setupEvent("setup.running", { workspacePath: "/api" }, null),
      setupEvent(
        "setup.failed",
        { workspacePath: "/web", setupExitCode: 9 },
        null,
      ),
    ]);
    expect(row.model.workspaces.map((w) => w.state)).toEqual([
      "setting-up",
      "failed",
    ]);
    expect(row.model.aggregate.state).toBe("failed");
  });

  it("lets failure dominate cancelled within one lifecycle window", () => {
    const row = onlyRow([
      setupEvent(
        "setup.failed",
        { workspacePath: "/api", setupExitCode: 4 },
        null,
      ),
      setupEvent("setup.cancelled", { workspacePath: "/web" }, null),
    ]);
    expect(row.model.aggregate.state).toBe("failed");
  });
});
