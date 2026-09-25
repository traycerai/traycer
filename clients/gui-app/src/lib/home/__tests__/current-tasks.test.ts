import { describe, expect, it } from "vitest";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import type {
  ListTaskLight,
  ListTasksResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  currentTaskPinScan,
  currentTaskPinsStatus,
  groupCurrentTasks,
  pinScanDecision,
  withInProgressFirst,
  PIN_TAIL_PAGE_CAP,
} from "@/lib/home/current-tasks";

function task(
  epicId: string,
  pinned: boolean,
  home: "local" | "cloud" | undefined,
): ListTaskLight {
  return {
    epic: {
      light: {
        id: epicId,
        title: epicId,
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "in_progress",
        createdAt: 0,
        updatedAt: 0,
        createdBy: "user-1",
        version: "1",
      },
      permission: null,
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
    phase: null,
    pinned,
    ...(home === undefined ? {} : { home }),
  };
}

function page(
  tasks: readonly ListTaskLight[],
  hasMore: boolean,
): ListTasksResponse {
  return {
    tasks: [...tasks],
    hasMore,
    ...(hasMore ? { nextCursor: "next" } : {}),
  };
}

function item(id: string, updatedAtMs: number, isPinned: boolean): HistoryItem {
  return {
    id,
    epicId: id,
    taskType: "epic",
    title: id,
    initialUserPrompt: "",
    updatedAtMs,
    updatedLabel: "now",
    updatedBucket: "today",
    linkedRepos: [],
    linkedWorkspaces: [],
    chatHostIds: null,
    pullRequestNumbers: [],
    worktreeBranches: [],
    worktreePaths: [],
    ownership: "mine",
    permissionRole: "owner",
    isPinned,
  };
}

describe("pinScanDecision", () => {
  it("ignores injected unpinned rows but stops at a cloud unpinned first-page row", () => {
    expect(
      pinScanDecision(page([task("local", false, "local")], true), "first", 0),
    ).toEqual({ shouldContinue: true, pinsComplete: false });
    expect(
      pinScanDecision(
        page([task("cloud", false, undefined)], true),
        "first",
        0,
      ),
    ).toEqual({ shouldContinue: false, pinsComplete: true });
  });

  it("stops at any unpinned cursor-page row", () => {
    expect(
      pinScanDecision(
        page([task("epic", false, undefined)], true),
        "cursor",
        1,
      ),
    ).toEqual({ shouldContinue: false, pinsComplete: true });
  });

  it("reports incomplete when the cursor-page cap is reached", () => {
    expect(
      pinScanDecision(
        page([task("epic", true, undefined)], true),
        "cursor",
        PIN_TAIL_PAGE_CAP,
      ),
    ).toEqual({ shouldContinue: false, pinsComplete: false });
  });
});

describe("currentTaskPinsStatus", () => {
  const completeFirstPage = {
    shouldContinue: false,
    pinsComplete: true,
  } as const;

  it("keeps cloud revalidation pending and pins incomplete", () => {
    expect(
      currentTaskPinsStatus({
        initialLegRefused: false,
        cloudPagePending: true,
        firstPagePending: false,
        firstPageUnavailable: false,
        firstPageLocalRowsIncomplete: false,
        firstPageDecision: completeFirstPage,
        tailEnabled: false,
        tailPending: false,
        tailPinsComplete: false,
      }),
    ).toEqual({ pinsComplete: false, isPending: true });
  });

  it("settles a refused initial leg without claiming pin completeness", () => {
    expect(
      currentTaskPinsStatus({
        initialLegRefused: true,
        cloudPagePending: false,
        firstPagePending: true,
        firstPageUnavailable: false,
        firstPageLocalRowsIncomplete: false,
        firstPageDecision: null,
        tailEnabled: false,
        tailPending: false,
        tailPinsComplete: false,
      }),
    ).toEqual({ pinsComplete: false, isPending: false });
  });
});

describe("currentTaskPinScan", () => {
  it("enables a host/user-scoped tail only after a settled first page", () => {
    expect(
      currentTaskPinScan({
        firstPage: page([task("pinned", true, undefined)], true),
        firstPagePlaceholder: false,
        cloudPagePending: false,
        hostId: "host-1",
        userId: "user-1",
      }),
    ).toMatchObject({
      tailEnabled: true,
      tailScope: {
        hostId: "host-1",
        userId: "user-1",
        firstPageCursor: "next",
      },
    });
  });
});

describe("groupCurrentTasks", () => {
  it("groups exclusively by in-progress, pinned, then open and preserves each order", () => {
    const groups = groupCurrentTasks(
      [
        item("working-old", 1, true),
        item("working-new", 4, false),
        item("pinned-old", 2, true),
        item("pinned-new", 3, true),
        item("open-a", 5, false),
        item("open-b", 6, false),
      ],
      new Set(["working-old", "working-new"]),
      ["open-b", "working-old", "pinned-new", "open-a"],
    );
    expect(groups.inProgress.map(({ id }) => id)).toEqual([
      "working-new",
      "working-old",
    ]);
    expect(groups.pinned.map(({ id }) => id)).toEqual([
      "pinned-new",
      "pinned-old",
    ]);
    expect(groups.open.map(({ id }) => id)).toEqual(["open-b", "open-a"]);
  });
});

describe("withInProgressFirst", () => {
  it("prepends a running task the feed never listed", () => {
    const feed = [item("a", 3, false), item("b", 2, false)];

    expect(
      withInProgressFirst([item("z", 1, false)], feed).map((row) => row.id),
    ).toEqual(["z", "a", "b"]);
  });

  it("lifts a listed running task out of the feed rather than copying it", () => {
    const feed = [
      item("a", 3, false),
      item("b", 2, false),
      item("c", 1, false),
    ];

    expect(withInProgressFirst([feed[2]], feed).map((row) => row.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("matches on the epic, not the row id, so a backfilled row is not a second copy", () => {
    // The feed's row and the by-id backfill's row for one epic can differ in
    // `id` - `itemId` folds the row's index into it - so an id-keyed dedup
    // would render the same task twice.
    const listed = { ...item("c", 1, false), id: "c#2" };
    const lifted = { ...item("c", 1, false), id: "c#0" };

    expect(
      withInProgressFirst([lifted], [item("a", 3, false), listed]).map(
        (row) => row.id,
      ),
    ).toEqual(["c#0", "a"]);
  });

  it("hands the feed straight back when nothing is running", () => {
    const feed = [item("a", 3, false)];

    // Identity, not just equality: an untouched list must not re-render the
    // always-mounted drawer on every page update.
    expect(withInProgressFirst([], feed)).toBe(feed);
  });
});
