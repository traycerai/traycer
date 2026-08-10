import { describe, expect, it } from "vitest";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import {
  buildProfileLandingEpicIntent,
  mostRecentOwnedEpic,
} from "../profile-landing";
import type { ProjectProfile } from "../types";

const PROFILE: ProjectProfile = {
  id: "p1",
  name: "Acme",
  icon: "rocket",
  color: "blue",
  folders: [{ path: "/Users/x/Acme", hostId: "h1" }],
  assignedEpicIds: [],
  createdAt: 0,
  updatedAt: 0,
};

function historyItem(overrides: {
  readonly epicId: string;
  readonly updatedAtMs: number;
  readonly linkedWorkspaces: ReadonlyArray<{
    readonly hostId: string;
    readonly workspacePath: string;
  }>;
}): HistoryItem {
  return {
    id: overrides.epicId,
    epicId: overrides.epicId,
    taskType: "epic",
    title: overrides.epicId,
    initialUserPrompt: "",
    updatedAtMs: overrides.updatedAtMs,
    updatedLabel: "",
    updatedBucket: "today",
    linkedRepos: [],
    linkedWorkspaces: overrides.linkedWorkspaces,
    pullRequestNumbers: [],
    worktreeBranches: [],
    worktreePaths: [],
    ownership: "mine",
    permissionRole: null,
    isPinned: false,
  };
}

describe("mostRecentOwnedEpic", () => {
  it("returns the most recently updated epic owned by the profile", () => {
    const items = [
      historyItem({
        epicId: "old-owned",
        updatedAtMs: 100,
        linkedWorkspaces: [
          { hostId: "h1", workspacePath: "/Users/x/Acme/apps/web" },
        ],
      }),
      historyItem({
        epicId: "new-owned",
        updatedAtMs: 200,
        linkedWorkspaces: [
          { hostId: "h1", workspacePath: "/Users/x/Acme" },
        ],
      }),
    ];
    expect(mostRecentOwnedEpic(PROFILE, items)?.epicId).toBe("new-owned");
  });

  it("ignores foreign epics even when newer", () => {
    const items = [
      historyItem({
        epicId: "owned",
        updatedAtMs: 100,
        linkedWorkspaces: [
          { hostId: "h1", workspacePath: "/Users/x/Acme" },
        ],
      }),
      historyItem({
        epicId: "foreign",
        updatedAtMs: 999,
        linkedWorkspaces: [{ hostId: "h1", workspacePath: "/Users/x/Bkza" }],
      }),
    ];
    expect(mostRecentOwnedEpic(PROFILE, items)?.epicId).toBe("owned");
  });

  it("ignores unscoped epics (no linked workspaces)", () => {
    const items = [
      historyItem({ epicId: "unscoped", updatedAtMs: 999, linkedWorkspaces: [] }),
    ];
    expect(mostRecentOwnedEpic(PROFILE, items)).toBe(null);
  });

  it("returns null when the profile owns nothing", () => {
    expect(mostRecentOwnedEpic(PROFILE, [])).toBe(null);
  });
});

describe("buildProfileLandingEpicIntent", () => {
  it("builds an open-epic intent for the most recent owned epic", () => {
    const intent = buildProfileLandingEpicIntent(PROFILE, [
      historyItem({
        epicId: "owned",
        updatedAtMs: 100,
        linkedWorkspaces: [
          { hostId: "h1", workspacePath: "/Users/x/Acme" },
        ],
      }),
    ]);
    expect(intent).not.toBe(null);
    expect(intent?.kind).toBe("open-epic");
    expect(intent?.epicId).toBe("owned");
  });

  it("returns null when there is no owned epic", () => {
    expect(buildProfileLandingEpicIntent(PROFILE, [])).toBe(null);
  });
});
