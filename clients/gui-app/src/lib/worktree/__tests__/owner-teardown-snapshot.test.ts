import { describe, expect, it } from "vitest";
import type { WorktreeBusyHolder } from "@traycer/protocol/framework/worktree-busy-holders";
import type {
  WorktreeBinding,
  WorktreeBindingEntry,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";
import {
  droppedRunDirectoriesFromDraft,
  pathContainsDirectory,
  snapshotOwnerTeardown,
  snapshotOwnerTeardownHolders,
  teardownHolderKey,
  type OwnerTeardownSnapshotInput,
} from "../owner-teardown-snapshot";

const OWNER: WorktreeBusyHolder["ownerRef"] = {
  epicId: "epic-1",
  ownerKind: "chat",
  ownerId: "chat-1",
};

function bindingEntry(
  workspacePath: string,
  worktreePath: string | null,
): WorktreeBindingEntry {
  return {
    workspacePath,
    mode: worktreePath === null ? "local" : "worktree",
    repoIdentifier: null,
    worktreePath,
    branch: worktreePath === null ? null : "feat",
    isPrimary: true,
    isImported: worktreePath !== null,
    setupState: "not_required",
    setupTerminalSessionId: null,
    setupExitCode: null,
    setupFailedAt: null,
    createdAt: 0,
  };
}

function binding(entries: readonly WorktreeBindingEntry[]): WorktreeBinding {
  return { entries: [...entries] };
}

function input(
  overrides: Partial<OwnerTeardownSnapshotInput>,
): OwnerTeardownSnapshotInput {
  return {
    ownerRef: OWNER,
    ownerLabel: "Planner",
    hasActiveTurn: false,
    ptyLive: false,
    shells: [],
    droppedRunDirectories: [],
    queuedMessageCount: 0,
    backgroundItemCount: 0,
    ...overrides,
  };
}

describe("snapshotOwnerTeardownHolders", () => {
  it("returns nothing when the owner is idle with no shells", () => {
    expect(snapshotOwnerTeardownHolders(input({}))).toEqual([]);
  });

  it("names a working chat turn and the agent.stop consequence", () => {
    expect(
      snapshotOwnerTeardownHolders(input({ hasActiveTurn: true })),
    ).toEqual([
      {
        ownerRef: OWNER,
        holdKind: "chat-turn",
        activity: "working",
        label:
          "Planner is working. Stopping the agent also stops its background shells and clears queued messages",
      },
    ]);
  });

  it("discloses a live PTY as a restart, not a loss", () => {
    expect(snapshotOwnerTeardownHolders(input({ ptyLive: true }))).toEqual([
      {
        ownerRef: OWNER,
        holdKind: "terminal-agent-pty",
        activity: "working",
        label: "Planner will restart in the new folder",
      },
    ]);
  });

  it("names a live shell on a dropped path by its command", () => {
    const holders = snapshotOwnerTeardownHolders(
      input({
        droppedRunDirectories: ["/wt/old"],
        shells: [
          {
            id: "sh-1",
            description: "watch",
            command: "npm run dev",
            cwd: "/wt/old/apps",
            live: true,
          },
          {
            id: "sh-2",
            description: "other",
            command: "sleep 1",
            cwd: "/wt/keep",
            live: true,
          },
        ],
      }),
    );
    expect(holders).toEqual([
      {
        ownerRef: OWNER,
        holdKind: "supervised-shell",
        activity: "working",
        label: "npm run dev",
      },
    ]);
  });

  it("omits shells when the draft drops no run directories", () => {
    expect(
      snapshotOwnerTeardownHolders(
        input({
          shells: [
            {
              id: "sh-1",
              description: "watch",
              command: "npm run dev",
              cwd: null,
              live: true,
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("excludes a live shell whose cwd is unknown even when paths are dropped", () => {
    expect(
      snapshotOwnerTeardownHolders(
        input({
          droppedRunDirectories: ["/wt/old"],
          shells: [
            {
              id: "sh-unknown",
              description: "watch",
              command: "npm run dev",
              cwd: null,
              live: true,
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("attaches a stop target with the shell id for GUI-composed teardown", () => {
    const snapshot = snapshotOwnerTeardown(
      input({
        droppedRunDirectories: ["/wt/old"],
        shells: [
          {
            id: "sh-1",
            description: "watch",
            command: "npm run dev",
            cwd: "/wt/old",
            live: true,
          },
        ],
      }),
    );
    expect(snapshot.holders).toHaveLength(1);
    expect(snapshot.stopTargets).toEqual([
      {
        kind: "supervised-shell",
        commandId: "sh-1",
        holderKey: teardownHolderKey({
          ownerRef: OWNER,
          holdKind: "supervised-shell",
          activity: "working",
          label: "npm run dev",
        }),
      },
    ]);
  });

  it("attaches a chat-turn stop target only for chat owners", () => {
    expect(
      snapshotOwnerTeardown(input({ hasActiveTurn: true })).stopTargets,
    ).toEqual([
      {
        kind: "chat-turn",
        holderKey:
          "chat:chat-1:chat-turn:Planner is working. Stopping the agent also stops its background shells and clears queued messages",
      },
    ]);
    expect(
      snapshotOwnerTeardown(
        input({
          ownerRef: { ...OWNER, ownerKind: "terminal-agent" },
          hasActiveTurn: true,
        }),
      ).stopTargets,
    ).toEqual([]);
  });

  it("includes a live shell on a retained path when a chat-turn will call agent.stop", () => {
    const holders = snapshotOwnerTeardownHolders(
      input({
        hasActiveTurn: true,
        droppedRunDirectories: ["/wt/old"],
        shells: [
          {
            id: "sh-keep",
            description: "keep",
            command: "sleep 1",
            cwd: "/wt/keep",
            live: true,
          },
        ],
      }),
    );
    expect(holders.map((holder) => holder.label)).toEqual([
      "Planner is working. Stopping the agent also stops its background shells and clears queued messages",
      "sleep 1",
    ]);
  });

  it("names queued work on the chat-turn row when evidence exists", () => {
    expect(
      snapshotOwnerTeardownHolders(
        input({ hasActiveTurn: true, queuedMessageCount: 2 }),
      )[0]?.label,
    ).toBe("Planner is working. Stopping it also clears 2 queued messages");
  });

  it("includes a shell under a pending-removed folder in the teardown set", () => {
    const dropped = droppedRunDirectoriesFromDraft({
      binding: binding([
        bindingEntry("/src/a", "/wt/a"),
        bindingEntry("/src/b", "/wt/b"),
      ]),
      draft: null,
      removedWorkspacePaths: ["/src/b"],
    });
    expect(dropped).toEqual(["/wt/b"]);
    expect(
      snapshotOwnerTeardownHolders(
        input({
          droppedRunDirectories: dropped,
          shells: [
            {
              id: "sh-b",
              description: "watch",
              command: "npm run dev",
              cwd: "/wt/b/apps",
              live: true,
            },
          ],
        }),
      ),
    ).toEqual([
      {
        ownerRef: OWNER,
        holdKind: "supervised-shell",
        activity: "working",
        label: "npm run dev",
      },
    ]);
  });
});

describe("droppedRunDirectoriesFromDraft", () => {
  it("drops the previous worktree when the draft switches to local", () => {
    const draft: WorktreeIntent = {
      entries: [
        {
          kind: "local",
          workspacePath: "/src/app",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    };
    expect(
      droppedRunDirectoriesFromDraft({
        binding: binding([bindingEntry("/src/app", "/wt/old")]),
        draft,
        removedWorkspacePaths: [],
      }),
    ).toEqual(["/wt/old"]);
  });

  it("returns empty when the draft keeps the same run directory", () => {
    const draft: WorktreeIntent = {
      entries: [
        {
          kind: "import",
          workspacePath: "/src/app",
          repoIdentifier: null,
          isPrimary: true,
          worktreePath: "/wt/old",
        },
      ],
    };
    expect(
      droppedRunDirectoriesFromDraft({
        binding: binding([bindingEntry("/src/app", "/wt/old")]),
        draft,
        removedWorkspacePaths: [],
      }),
    ).toEqual([]);
  });
});

describe("pathContainsDirectory", () => {
  it("treats equal and descendant paths as contained", () => {
    expect(pathContainsDirectory("/wt/a", "/wt/a")).toBe(true);
    expect(pathContainsDirectory("/wt/a", "/wt/a/src")).toBe(true);
    expect(pathContainsDirectory("/wt/a", "/wt/ab")).toBe(false);
  });
});
