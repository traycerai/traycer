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
  snapshotOwnerTeardownHolders,
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
    ...overrides,
  };
}

describe("snapshotOwnerTeardownHolders", () => {
  it("returns nothing when the owner is idle with no shells", () => {
    expect(snapshotOwnerTeardownHolders(input({}))).toEqual([]);
  });

  it("names a working chat turn", () => {
    expect(snapshotOwnerTeardownHolders(input({ hasActiveTurn: true }))).toEqual(
      [
        {
          ownerRef: OWNER,
          holdKind: "chat-turn",
          activity: "working",
          label: "Planner is working",
        },
      ],
    );
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
