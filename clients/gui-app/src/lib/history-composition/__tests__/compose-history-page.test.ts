import { describe, expect, it } from "vitest";
import type { LocalHistoryReadResponse } from "@traycer/protocol/host/epic/local-history";
import type {
  ListTaskLight,
  ListTasksResponse,
  PermissionRole,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  composeHistoryPage,
  composeHistoryPageWithoutPool,
  hostLocalHistoryPage,
  type HistoryHostContribution,
  type HistoryLocalRowsPlacement,
} from "../compose-history-page";

function row(
  id: string,
  overrides: {
    readonly role: PermissionRole | null;
    readonly updatedAt: number;
    readonly recentAt: number | undefined;
    readonly pinned: boolean | undefined;
  },
): ListTaskLight {
  return {
    epic: {
      light: {
        id,
        title: `Title ${id}`,
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "active",
        createdAt: 1,
        updatedAt: overrides.updatedAt,
        createdBy: "u",
        version: "1",
      },
      permission:
        overrides.role === null
          ? null
          : {
              role: overrides.role,
              accessType: "direct",
              grantedBy: "u",
              grantedAt: 1,
            },
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
    recentAt: overrides.recentAt,
    pinned: overrides.pinned,
  };
}

const plain = (id: string, updatedAt: number): ListTaskLight =>
  row(id, { role: "owner", updatedAt, recentAt: undefined, pinned: undefined });

function readOf(
  overrides: Partial<LocalHistoryReadResponse>,
): HistoryHostContribution {
  return {
    kind: "contributed",
    read: {
      complete: true,
      willComplete: true,
      localHomeRows: [],
      preservedRows: [],
      tombstonedEpicIds: [],
      localRows: "none",
      ...overrides,
    },
  };
}

function pageOf(
  tasks: readonly ListTaskLight[],
  extra: Partial<ListTasksResponse>,
): ListTasksResponse {
  return {
    tasks: [...tasks],
    hasMore: false,
    completeness: {
      cloudPage: "settled",
      facets: "server",
      localRows: "none",
      sort: "server",
    },
    ...extra,
  };
}

const ids = (page: ListTasksResponse): (string | undefined)[] =>
  page.tasks.map((task) => task.epic?.light?.id);

function compose(
  page: ListTasksResponse,
  contribution: HistoryHostContribution,
  placement: HistoryLocalRowsPlacement,
) {
  return composeHistoryPage({
    page,
    contribution,
    sort: "recent",
    query: undefined,
    placement,
  });
}

describe("composeHistoryPage", () => {
  it.each(["admit", "cursor-page"] as const)(
    "removes a tombstoned pool row on a %s placement",
    (placement) => {
      const composed = compose(
        pageOf([plain("a", 5), plain("b", 4)], {}),
        readOf({ tombstonedEpicIds: ["a"] }),
        placement,
      );

      expect(ids(composed)).toEqual(["b"]);
      expect(composed.completeness?.facets).toBe("partial");
    },
  );

  it("lets a local home replace the pool row for its id, with the lesser of the two roles", () => {
    const pool = row("a", {
      role: "viewer",
      updatedAt: 5,
      recentAt: undefined,
      pinned: undefined,
    });
    const local = row("a", {
      role: "owner",
      updatedAt: 9,
      recentAt: undefined,
      pinned: undefined,
    });

    const composed = compose(
      pageOf([pool], {}),
      readOf({ localHomeRows: [local], localRows: "present" }),
      "admit",
    );

    expect(composed.tasks).toHaveLength(1);
    expect(composed.tasks[0]?.epic?.light?.updatedAt).toBe(9);
    expect(composed.tasks[0]?.epic?.permission?.role).toBe("viewer");
    expect(composed.completeness).toMatchObject({
      facets: "partial",
      localRows: "present",
      sort: "loaded-union",
    });
  });

  it("keeps a local home's role when the pool row is no more permissive", () => {
    const pool = row("a", {
      role: "owner",
      updatedAt: 5,
      recentAt: undefined,
      pinned: undefined,
    });
    const local = row("a", {
      role: "editor",
      updatedAt: 9,
      recentAt: undefined,
      pinned: undefined,
    });

    const composed = compose(
      pageOf([pool], {}),
      readOf({ localHomeRows: [local], localRows: "present" }),
      "admit",
    );

    expect(composed.tasks[0]?.epic?.permission?.role).toBe("editor");
  });

  it("lets a preserved orphan fill only a gap", () => {
    const poolRow = plain("a", 5);
    const composed = compose(
      pageOf([poolRow], {}),
      readOf({
        preservedRows: [plain("a", 99), plain("orphan", 1)],
        localRows: "present",
      }),
      "admit",
    );

    expect(ids(composed).toSorted()).toEqual(["a", "orphan"]);
    expect(composed.tasks.find((t) => t.epic?.light?.id === "a")).toBe(poolRow);
  });

  it("injects no positive rows for an unprovable filter and says so", () => {
    const composed = compose(
      pageOf([plain("a", 5)], {}),
      readOf({
        localHomeRows: [plain("local", 9)],
        preservedRows: [plain("orphan", 1)],
        localRows: "present",
        tombstonedEpicIds: ["gone"],
      }),
      "unprovable-filter",
    );

    expect(ids(composed)).toEqual(["a"]);
    expect(composed.completeness).toMatchObject({
      localRows: "suppressed-unprovable-filter",
      facets: "server",
      sort: "server",
    });
  });

  it("states no local rows on a cursor page and keeps the pool's paging", () => {
    const composed = compose(
      pageOf([plain("a", 5)], { hasMore: true, nextCursor: "next" }),
      readOf({ localHomeRows: [plain("local", 9)], localRows: "present" }),
      "cursor-page",
    );

    expect(ids(composed)).toEqual(["a"]);
    expect(composed.hasMore).toBe(true);
    expect(composed.nextCursor).toBe("next");
    expect(composed.completeness?.localRows).toBe("none");
  });

  it("states reduced coverage when the host contributes nothing", () => {
    const composed = compose(
      pageOf([plain("a", 5)], {}),
      { kind: "absent" },
      "admit",
    );

    expect(ids(composed)).toEqual(["a"]);
    expect(composed.completeness).toMatchObject({
      facets: "partial",
      localRows: "truncated",
      cloudPage: "settled",
    });
  });

  it("keeps facets server-computed only while nothing is injected or removed", () => {
    const composed = compose(
      pageOf([plain("a", 5)], {}),
      readOf({ tombstonedEpicIds: ["unrelated"] }),
      "admit",
    );

    expect(composed.completeness).toMatchObject({
      facets: "server",
      sort: "server",
    });
  });

  it("orders the recent view pinned first, then recentAt, then id", () => {
    const pinned = row("p", {
      role: "owner",
      updatedAt: 1,
      recentAt: 1,
      pinned: true,
    });
    const newer = row("n", {
      role: "owner",
      updatedAt: 1,
      recentAt: 50,
      pinned: undefined,
    });
    const tieLow = row("a", {
      role: "owner",
      updatedAt: 1,
      recentAt: 20,
      pinned: undefined,
    });
    const tieHigh = row("b", {
      role: "owner",
      updatedAt: 1,
      recentAt: 20,
      pinned: undefined,
    });

    const composed = compose(
      pageOf([tieLow, newer, pinned], {}),
      readOf({ localHomeRows: [tieHigh], localRows: "present" }),
      "admit",
    );

    expect(ids(composed)).toEqual(["p", "n", "b", "a"]);
  });

  it("leaves rows where composed when the sort is not recent", () => {
    const composed = composeHistoryPage({
      page: pageOf([plain("a", 1)], {}),
      contribution: readOf({
        localHomeRows: [plain("z", 99)],
        localRows: "present",
      }),
      sort: "title-asc",
      query: undefined,
      placement: "admit",
    });

    expect(ids(composed)).toEqual(["z", "a"]);
  });
});

describe("composeHistoryPageWithoutPool", () => {
  const input = (
    contribution: HistoryHostContribution,
    placement: HistoryLocalRowsPlacement,
  ) => ({ contribution, placement, sort: "recent" as const, query: undefined });

  it("is null for an absent contribution or a non-admit placement", () => {
    const withRows = readOf({ localHomeRows: [plain("a", 1)] });
    expect(
      composeHistoryPageWithoutPool(input({ kind: "absent" }, "admit")),
    ).toBeNull();
    expect(
      composeHistoryPageWithoutPool(input(withRows, "cursor-page")),
    ).toBeNull();
    expect(
      composeHistoryPageWithoutPool(input(withRows, "unprovable-filter")),
    ).toBeNull();
  });

  it("states an empty page when the host answered completely with no rows", () => {
    const page = composeHistoryPageWithoutPool(input(readOf({}), "admit"));

    expect(page?.tasks).toEqual([]);
    expect(page?.completeness).toMatchObject({
      cloudPage: "unavailable",
      facets: "partial",
    });
  });

  it("states a page whose cloud half is unavailable", () => {
    const page = composeHistoryPageWithoutPool(
      input(
        readOf({
          localHomeRows: [plain("a", 1)],
          preservedRows: [plain("b", 2)],
          localRows: "present",
        }),
        "admit",
      ),
    );

    expect(page).not.toBeNull();
    expect(ids(page ?? pageOf([], {})).toSorted()).toEqual(["a", "b"]);
    expect(page?.hasMore).toBe(false);
    expect(page?.completeness).toEqual({
      cloudPage: "unavailable",
      facets: "partial",
      localRows: "present",
      sort: "loaded-union",
    });
  });
});

describe("hostLocalHistoryPage", () => {
  it("lists the host's own rows with its completeness", () => {
    const contribution = readOf({
      localHomeRows: [plain("a", 1)],
      preservedRows: [plain("b", 2)],
      localRows: "present",
    });
    if (contribution.kind !== "contributed") {
      throw new Error("expected a contributed read");
    }
    const page = hostLocalHistoryPage(contribution.read);

    expect(ids(page)).toEqual(["a", "b"]);
    expect(page.completeness).toMatchObject({
      cloudPage: "unavailable",
      localRows: "present",
    });
  });
});
