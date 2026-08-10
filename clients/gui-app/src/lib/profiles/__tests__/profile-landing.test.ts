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
        linkedWorkspaces: [{ hostId: "h1", workspacePath: "/Users/x/Acme" }],
      }),
    ];
    expect(mostRecentOwnedEpic(PROFILE, items, null)?.epicId).toBe("new-owned");
  });

  it("ignores foreign epics even when newer", () => {
    const items = [
      historyItem({
        epicId: "owned",
        updatedAtMs: 100,
        linkedWorkspaces: [{ hostId: "h1", workspacePath: "/Users/x/Acme" }],
      }),
      historyItem({
        epicId: "foreign",
        updatedAtMs: 999,
        linkedWorkspaces: [{ hostId: "h1", workspacePath: "/Users/x/Bkza" }],
      }),
    ];
    expect(mostRecentOwnedEpic(PROFILE, items, null)?.epicId).toBe("owned");
  });

  it("ignores unscoped epics (no linked workspaces)", () => {
    const items = [
      historyItem({
        epicId: "unscoped",
        updatedAtMs: 999,
        linkedWorkspaces: [],
      }),
    ];
    expect(mostRecentOwnedEpic(PROFILE, items, null)).toBe(null);
  });

  it("returns null when the profile owns nothing", () => {
    expect(mostRecentOwnedEpic(PROFILE, [], null)).toBe(null);
  });

  it("restricts candidates to the given id set (closed tabs never win)", () => {
    const items = [
      historyItem({
        epicId: "closed-epic",
        updatedAtMs: 999,
        linkedWorkspaces: [{ hostId: "h1", workspacePath: "/Users/x/Acme" }],
      }),
      historyItem({
        epicId: "open-epic",
        updatedAtMs: 100,
        linkedWorkspaces: [{ hostId: "h1", workspacePath: "/Users/x/Acme" }],
      }),
    ];
    // The newer epic is owned but NOT in the open set: it was closed.
    expect(
      mostRecentOwnedEpic(PROFILE, items, new Set(["open-epic"]))?.epicId,
    ).toBe("open-epic");
  });

  it("returns null for an empty restriction set (all tabs closed)", () => {
    const items = [
      historyItem({
        epicId: "closed-epic",
        updatedAtMs: 999,
        linkedWorkspaces: [{ hostId: "h1", workspacePath: "/Users/x/Acme" }],
      }),
    ];
    expect(mostRecentOwnedEpic(PROFILE, items, new Set())).toBe(null);
  });
});

describe("buildProfileLandingEpicIntent", () => {
  const ownedItem = (): HistoryItem =>
    historyItem({
      epicId: "owned",
      updatedAtMs: 100,
      linkedWorkspaces: [{ hostId: "h1", workspacePath: "/Users/x/Acme" }],
    });

  it("builds an open-epic intent for the most recent owned epic (cold open)", () => {
    const intent = buildProfileLandingEpicIntent(PROFILE, [ownedItem()], null);
    expect(intent).not.toBe(null);
    expect(intent?.kind).toBe("open-epic");
    expect(intent?.epicId).toBe("owned");
  });

  it("targets an OPEN epic even when a newer owned epic is closed", () => {
    const items = [
      ownedItem(),
      historyItem({
        epicId: "owned-closed",
        updatedAtMs: 200,
        linkedWorkspaces: [{ hostId: "h1", workspacePath: "/Users/x/Acme" }],
      }),
    ];
    const intent = buildProfileLandingEpicIntent(
      PROFILE,
      items,
      new Set(["owned"]),
    );
    expect(intent?.epicId).toBe("owned");
  });

  it("returns null when the open set has no owned epic (stay on surface)", () => {
    const intent = buildProfileLandingEpicIntent(
      PROFILE,
      [ownedItem()],
      new Set(["some-other-epic"]),
    );
    expect(intent).toBe(null);
  });

  it("returns null when the open set is empty (user closed every tab)", () => {
    const intent = buildProfileLandingEpicIntent(
      PROFILE,
      [ownedItem()],
      new Set(),
    );
    expect(intent).toBe(null);
  });

  it("returns null when there is no owned epic", () => {
    expect(buildProfileLandingEpicIntent(PROFILE, [], null)).toBe(null);
  });
});
