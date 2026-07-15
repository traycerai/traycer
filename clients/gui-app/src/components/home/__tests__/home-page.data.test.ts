import { describe, expect, it } from "vitest";
import type { ListTaskLight } from "@traycer/protocol/host/epic/unary-schemas";
import type { WorktreeHostEntryV12 } from "@traycer/protocol/host/worktree-schemas";
import {
  buildHistoryItemsFromTasks,
  collectHistoryRepos,
  filterHistoryItems,
  groupHistoryItems,
  prioritizePinnedHistoryItems,
  sortHistoryItems,
  withHistoryItemPullRequestNumbers,
  type HistoryItem,
} from "@/components/home/data/home-page.data";

function makeItem(
  overrides: Partial<HistoryItem> & { id: string; title: string },
): HistoryItem {
  return {
    id: overrides.id,
    epicId: overrides.epicId ?? overrides.id,
    taskType: overrides.taskType ?? "epic",
    title: overrides.title,
    initialUserPrompt: overrides.initialUserPrompt ?? "",
    updatedAtMs: overrides.updatedAtMs ?? 1,
    updatedLabel: overrides.updatedLabel ?? "x",
    updatedBucket: overrides.updatedBucket ?? "today",
    linkedRepos: overrides.linkedRepos ?? [],
    linkedWorkspaces: overrides.linkedWorkspaces ?? [],
    pullRequestNumbers: overrides.pullRequestNumbers ?? [],
    ownership: overrides.ownership ?? "mine",
    permissionRole: overrides.permissionRole ?? "owner",
    isPinned: overrides.isPinned ?? false,
  };
}

describe("home-page history helpers", () => {
  it("collects unique repos across items", () => {
    const items: ReadonlyArray<HistoryItem> = [
      makeItem({ id: "a", title: "A", linkedRepos: ["gui-app", "mobile"] }),
      makeItem({ id: "b", title: "B", linkedRepos: ["mobile"] }),
      makeItem({ id: "c", title: "C", linkedRepos: ["host"] }),
    ];
    expect(collectHistoryRepos(items)).toEqual(["gui-app", "host", "mobile"]);
  });

  it("supports repo filtering in any and all modes", () => {
    const items: ReadonlyArray<HistoryItem> = [
      makeItem({ id: "a", title: "A", linkedRepos: ["gui-app", "mobile"] }),
      makeItem({ id: "b", title: "B", linkedRepos: ["mobile"] }),
      makeItem({ id: "c", title: "C", linkedRepos: ["host"] }),
    ];
    expect(
      filterHistoryItems(items, {
        repoNames: ["mobile"],
        repoMatchMode: "any",
        workspaces: [],
        workspaceMatchMode: "any",
        ownershipScopes: [],
      }),
    ).toHaveLength(2);

    expect(
      filterHistoryItems(items, {
        repoNames: ["gui-app", "mobile"],
        repoMatchMode: "all",
        workspaces: [],
        workspaceMatchMode: "any",
        ownershipScopes: [],
      }),
    ).toHaveLength(1);
  });

  it("groups filtered items into recency sections", () => {
    const items: ReadonlyArray<HistoryItem> = [
      makeItem({ id: "a", title: "A", updatedBucket: "today" }),
      makeItem({ id: "c", title: "C", updatedBucket: "earlier" }),
    ];
    const groups = groupHistoryItems(items);
    expect(groups.map((g) => g.bucket)).toEqual(["today", "earlier"]);
  });

  it("keeps pinned items first while preserving the active sort within each block", () => {
    const items = [
      makeItem({ id: "a", title: "Alpha", isPinned: false }),
      makeItem({ id: "z", title: "Zulu", isPinned: true }),
      makeItem({ id: "b", title: "Bravo", isPinned: true }),
      makeItem({ id: "c", title: "Charlie", isPinned: false }),
    ];

    expect(sortHistoryItems(items, "title-asc").map((item) => item.id)).toEqual(
      ["b", "z", "a", "c"],
    );
  });

  it("stably promotes pinned items in relevance-ranked results", () => {
    const items = [
      makeItem({ id: "best", title: "Best match", isPinned: false }),
      makeItem({ id: "pinned-1", title: "Pinned one", isPinned: true }),
      makeItem({ id: "next", title: "Next match", isPinned: false }),
      makeItem({ id: "pinned-2", title: "Pinned two", isPinned: true }),
    ];

    expect(prioritizePinnedHistoryItems(items).map((item) => item.id)).toEqual([
      "pinned-1",
      "pinned-2",
      "best",
      "next",
    ]);
  });

  it("projects distinct superproject and submodule PR numbers for a task", () => {
    const items = [makeItem({ id: "history-1", title: "History task" })];
    const worktreesByEpicId = new Map([
      [
        "history-1",
        [
          worktreeWithPullRequests({
            prNumber: 84,
            submodulePrNumbers: [85, null],
          }),
          worktreeWithPullRequests({
            prNumber: 84,
            submodulePrNumbers: [85],
          }),
        ],
      ],
    ]);

    expect(
      withHistoryItemPullRequestNumbers(items, worktreesByEpicId)[0]
        .pullRequestNumbers,
    ).toEqual(["84", "#84", "PR #84", "85", "#85", "PR #85"]);
  });

  it("builds history items from cloud task lights and extracts real repo identifiers", () => {
    const tasks: ReadonlyArray<ListTaskLight> = [
      {
        epic: {
          light: {
            id: "epic-real",
            title: "Real epic",
            initialUserPrompt: "Ship it",
            ticketCount: 0,
            specCount: 0,
            storyCount: 0,
            reviewCount: 0,
            status: "draft",
            createdAt: Date.parse("2026-04-21T09:00:00.000Z"),
            updatedAt: Date.parse("2026-04-22T09:00:00.000Z"),
            createdBy: "user-1",
            version: "1",
          },
          permission: null,
          repos: [
            {
              task: null,
              repoIdentifier: { owner: "traycerai", repo: "gui-app" },
              createdAt: 0,
              createdBy: "user-1",
            },
            {
              task: null,
              repoIdentifier: { owner: "traycerai", repo: "host" },
              createdAt: 0,
              createdBy: "user-1",
            },
          ],
          workspaces: [],
          roomInfo: null,
        },
        phase: null,
        pinned: true,
      },
      {
        epic: null,
        phase: {
          light: {
            id: "phase-real",
            title: "Real phase",
            userQuery: "Do phase work",
            phaseLength: 2,
            status: "ready",
            createdAt: Date.parse("2026-04-20T09:00:00.000Z"),
            updatedAt: Date.parse("2026-04-22T10:00:00.000Z"),
            createdBy: "user-1",
            version: "1.0.0",
          },
          permission: null,
          repos: [
            {
              task: null,
              repoIdentifier: { owner: "traycerai", repo: "gui-app" },
              createdAt: 0,
              createdBy: "user-1",
            },
          ],
          workspaces: [],
          roomInfo: null,
        },
        // A phase can never legitimately be pinned - the raw task carries
        // `pinned: true` here to prove the projection ignores it rather
        // than merely happening to see `false`.
        pinned: true,
      },
    ];

    const items = buildHistoryItemsFromTasks(
      tasks,
      Date.parse("2026-04-22T12:00:00.000Z"),
      "user-1",
    );

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      epicId: "epic-real",
      taskType: "epic",
      title: "Real epic",
      // Raw prompt is threaded through so render sites can derive the
      // empty-title fallback from it.
      initialUserPrompt: "Ship it",
      updatedBucket: "today",
      linkedRepos: ["traycerai/gui-app", "traycerai/host"],
      ownership: "mine",
      permissionRole: "owner",
      isPinned: true,
    });
    expect(items[1]).toMatchObject({
      id: "phase-phase-real",
      epicId: "phase-real",
      taskType: "phase",
      title: "Real phase",
      // Phases have no user prompt.
      initialUserPrompt: "",
      updatedBucket: "today",
      linkedRepos: ["traycerai/gui-app"],
      isPinned: false,
    });
  });
});

function worktreeWithPullRequests(args: {
  readonly prNumber: number | null;
  readonly submodulePrNumbers: ReadonlyArray<number | null>;
}): WorktreeHostEntryV12 {
  return {
    worktreePath: `/worktrees/${args.prNumber ?? "none"}`,
    repoLabel: "traycer/gui-app",
    repoIdentifier: { owner: "traycer", repo: "gui-app" },
    branch: "task-history",
    inUse: false,
    uncommittedCount: 0,
    gitRemovable: true,
    scripts: null,
    lastActivityAt: null,
    owners: [],
    branchStatus: null,
    createdAt: null,
    prState: args.prNumber === null ? "none" : "open",
    prNumber: args.prNumber,
    prUrl:
      args.prNumber === null
        ? null
        : `https://github.com/traycer/gui-app/pull/${args.prNumber}`,
    mergedHeadShaMatches: false,
    submodules: args.submodulePrNumbers.map((prNumber, index) => ({
      repoIdentifier: { owner: "traycer", repo: `submodule-${index}` },
      branch: `submodule-${index}`,
      prState: prNumber === null ? "none" : "open",
      prNumber,
      prUrl:
        prNumber === null
          ? null
          : `https://github.com/traycer/submodule-${index}/pull/${prNumber}`,
      mergedHeadShaMatches: false,
      mergedIntoDefault: false,
      atPinnedCommit: false,
      unmergedCommitCount: null,
      unmergedCommitSubjects: null,
    })),
    atBaseCommit: false,
  };
}
