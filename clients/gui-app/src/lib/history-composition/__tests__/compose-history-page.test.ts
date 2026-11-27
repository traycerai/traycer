import { describe, expect, it } from "vitest";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import {
  historyPageFromAddress,
  type HistoryListedPage,
} from "../history-row-peer";
import { grantedRole } from "@traycer/protocol/common/permission-role";
import type {
  ListTaskLight,
  ListTasksResponse,
  WirePermissionRole,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  type ComputerLocalHomeHistoryRow,
  type PagePosition,
  type PreservedCloudHistoryRow,
  completeLocalHistoryRead,
  computerLocalHomeRow,
  directHistoryGrant,
  poolListedTaskAt17,
  preservedCloudLocalHistoryRow,
  settledPoolPageAt17,
} from "../test-support/history-wire-fixtures";
import {
  composeHistoryPage,
  composeHistoryPageWithoutPool,
  historyCoverageIsReduced,
  hostLocalHistoryPage,
  type HistoryHostContribution,
  type HistoryLocalRowsPlacement,
} from "../compose-history-page";

function poolRow(
  id: string,
  overrides: {
    readonly role: WirePermissionRole | null;
    readonly updatedAt: number;
    readonly recentAt: number | undefined;
    readonly pinned: boolean | undefined;
  },
): ListTaskLight {
  return poolListedTaskAt17({
    id,
    title: `Title ${id}`,
    grant:
      overrides.role === null ? null : directHistoryGrant(overrides.role, "u"),
    pinned: overrides.pinned ?? false,
    recentAt: overrides.recentAt,
    updatedAt: overrides.updatedAt,
  });
}

const plain = (id: string, updatedAt: number): ListTaskLight =>
  poolRow(id, {
    role: "owner",
    updatedAt,
    recentAt: undefined,
    pinned: false,
  });

const localRow = ({
  id,
  recentAt,
  updatedAt,
  pinned,
  createdAt,
}: {
  readonly id: string;
  readonly recentAt: number;
  readonly updatedAt: number;
  readonly pinned: boolean;
  readonly createdAt: number;
}): ComputerLocalHomeHistoryRow =>
  computerLocalHomeRow({
    id,
    title: `Title ${id}`,
    recentAt,
    pinned,
    userId: "u",
    createdAt,
    updatedAt,
  });

const preservedRow = (
  id: string,
  recentAt: number,
  updatedAt: number,
): PreservedCloudHistoryRow =>
  preservedCloudLocalHistoryRow(id, `Title ${id}`, recentAt, updatedAt);

function readOf(overrides: {
  readonly localHomeRows?: readonly ComputerLocalHomeHistoryRow[];
  readonly preservedRows?: readonly PreservedCloudHistoryRow[];
  readonly tombstonedEpicIds?: readonly string[];
}): HistoryHostContribution {
  return {
    kind: "contributed",
    read: completeLocalHistoryRead(
      overrides.localHomeRows ?? [],
      overrides.preservedRows ?? [],
      overrides.tombstonedEpicIds ?? [],
    ),
  };
}

function pageOf(
  tasks: readonly ListTaskLight[],
  position: PagePosition,
): HistoryListedPage {
  return historyPageFromAddress(
    settledPoolPageAt17(tasks, position, "u"),
    POOL_HOST_ID,
  );
}

const ids = (page: ListTasksResponse): (string | undefined)[] =>
  page.tasks.map((task) => task.epic?.light?.id);

function compose(
  page: HistoryListedPage,
  contribution: HistoryHostContribution,
  placement: HistoryLocalRowsPlacement,
) {
  return composeHistoryPage({
    page,
    contribution,
    contributingPeerId: "host-1",
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
        pageOf([plain("a", 5), plain("b", 4)], {
          hasMore: false,
          nextCursor: undefined,
        }),
        readOf({ tombstonedEpicIds: ["a"] }),
        placement,
      );

      expect(ids(composed)).toEqual(["b"]);
      expect(composed.completeness?.facets).toBe("partial");
    },
  );

  it("lets a local home replace the pool row for its id, with the lesser of the two roles", () => {
    const pool = poolRow("a", {
      role: "viewer",
      updatedAt: 5,
      recentAt: undefined,
      pinned: undefined,
    });
    const local = localRow({
      id: "a",
      recentAt: 9,
      updatedAt: 9,
      pinned: false,
      createdAt: 1,
    });

    const composed = compose(
      pageOf([pool], { hasMore: false, nextCursor: undefined }),
      readOf({ localHomeRows: [local] }),
      "admit",
    );

    expect(composed.tasks).toHaveLength(1);
    expect(composed.tasks[0]?.epic?.light?.updatedAt).toBe(9);
    // Compared as access: a `viewer` role gives the access of `editor`, which
    // is less than the local home's owner.
    expect(grantedRole(composed.tasks[0]?.epic?.permission?.role ?? null)).toBe(
      "editor",
    );
    expect(composed.completeness).toMatchObject({
      facets: "partial",
      localRows: "present",
      sort: "loaded-union",
    });
  });

  it("keeps a local home's owner role when the pool row is also owner", () => {
    const pool = poolRow("a", {
      role: "owner",
      updatedAt: 5,
      recentAt: undefined,
      pinned: undefined,
    });
    const local = localRow({
      id: "a",
      recentAt: 9,
      updatedAt: 9,
      pinned: false,
      createdAt: 1,
    });

    const composed = compose(
      pageOf([pool], { hasMore: false, nextCursor: undefined }),
      readOf({ localHomeRows: [local] }),
      "admit",
    );

    expect(composed.tasks[0]?.epic?.permission?.role).toBe("owner");
  });

  it("lets a preserved orphan fill only a gap", () => {
    const poolPage = pageOf([plain("a", 5)], {
      hasMore: false,
      nextCursor: undefined,
    });
    const composed = compose(
      poolPage,
      readOf({
        preservedRows: [
          preservedRow("a", 99, 99),
          preservedRow("orphan", 1, 1),
        ],
      }),
      "admit",
    );

    expect(ids(composed).toSorted()).toEqual(["a", "orphan"]);
    expect(composed.tasks.find((t) => t.epic?.light?.id === "a")).toBe(
      poolPage.tasks[0],
    );
    expect(
      composed.tasks.find((t) => t.epic?.light?.id === "orphan")
        ?.listedByPeerId,
    ).toBe("host-1");
  });

  it("injects no positive rows for an unprovable filter and says so", () => {
    const composed = compose(
      pageOf([plain("a", 5)], { hasMore: false, nextCursor: undefined }),
      readOf({
        localHomeRows: [
          localRow({
            id: "local",
            recentAt: 9,
            updatedAt: 9,
            pinned: false,
            createdAt: 1,
          }),
        ],
        preservedRows: [preservedRow("orphan", 1, 1)],
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
      readOf({
        localHomeRows: [
          localRow({
            id: "local",
            recentAt: 9,
            updatedAt: 9,
            pinned: false,
            createdAt: 1,
          }),
        ],
      }),
      "cursor-page",
    );

    expect(ids(composed)).toEqual(["a"]);
    expect(composed.hasMore).toBe(true);
    expect(composed.nextCursor).toBe("next");
    expect(composed.completeness?.localRows).toBe("none");
  });

  it("states reduced coverage when the host contributes nothing", () => {
    const composed = compose(
      pageOf([plain("a", 5)], { hasMore: false, nextCursor: undefined }),
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
      pageOf([plain("a", 5)], { hasMore: false, nextCursor: undefined }),
      readOf({ tombstonedEpicIds: ["unrelated"] }),
      "admit",
    );

    expect(composed.completeness).toMatchObject({
      facets: "server",
      sort: "server",
    });
  });

  it("orders the recent view pinned first, then recentAt, then id", () => {
    const pinned = poolRow("p", {
      role: "owner",
      updatedAt: 1,
      recentAt: 1,
      pinned: true,
    });
    const newer = poolRow("n", {
      role: "owner",
      updatedAt: 1,
      recentAt: 50,
      pinned: undefined,
    });
    const tieLow = poolRow("a", {
      role: "owner",
      updatedAt: 1,
      recentAt: 20,
      pinned: undefined,
    });
    const tieHigh = localRow({
      id: "b",
      recentAt: 20,
      updatedAt: 1,
      pinned: false,
      createdAt: 1,
    });

    const composed = compose(
      pageOf([tieLow, newer, pinned], {
        hasMore: false,
        nextCursor: undefined,
      }),
      readOf({ localHomeRows: [tieHigh] }),
      "admit",
    );

    expect(ids(composed)).toEqual(["p", "n", "b", "a"]);
  });

  it("orders the created-desc view pinned first, then createdAt, ignoring activity", () => {
    const createdPool = (
      id: string,
      createdAt: number,
      pinned: boolean | undefined,
    ): ListTaskLight => {
      const base = poolRow(id, {
        role: "owner",
        updatedAt: 1,
        recentAt: undefined,
        pinned,
      });
      const epic = base.epic;
      if (epic === undefined || epic === null || !epic.light) {
        throw new Error("no light");
      }
      return {
        ...base,
        epic: { ...epic, light: { ...epic.light, createdAt } },
      };
    };
    // The oldest-created pool row has the newest activity: creation decides.
    const active = {
      ...createdPool("active", 10, undefined),
      recentAt: 900,
    };

    const composed = composeHistoryPage({
      page: pageOf([createdPool("pinned", 5, true), active], {
        hasMore: false,
        nextCursor: undefined,
      }),
      contributingPeerId: "host-1",
      contribution: readOf({
        localHomeRows: [
          localRow({
            id: "local-new",
            recentAt: 100,
            updatedAt: 100,
            pinned: false,
            createdAt: 100,
          }),
        ],
      }),
      sort: "created-desc",
      query: undefined,
      placement: "admit",
    });

    expect(ids(composed)).toEqual(["pinned", "local-new", "active"]);
  });

  it("leaves rows where composed when the sort is not recent", () => {
    const composed = composeHistoryPage({
      page: pageOf([plain("a", 1)], { hasMore: false, nextCursor: undefined }),
      contributingPeerId: "host-1",
      contribution: readOf({
        localHomeRows: [
          localRow({
            id: "z",
            recentAt: 99,
            updatedAt: 99,
            pinned: false,
            createdAt: 1,
          }),
        ],
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
  ) => ({
    contribution,
    contributingPeerId: "host-1",
    placement,
    sort: "recent" as const,
    query: undefined,
  });

  it("is null for an absent contribution or a non-admit placement", () => {
    const withRows = readOf({
      localHomeRows: [
        localRow({
          id: "a",
          recentAt: 1,
          updatedAt: 1,
          pinned: false,
          createdAt: 1,
        }),
      ],
    });
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
          localHomeRows: [
            localRow({
              id: "a",
              recentAt: 1,
              updatedAt: 1,
              pinned: false,
              createdAt: 1,
            }),
          ],
          preservedRows: [preservedRow("b", 2, 2)],
        }),
        "admit",
      ),
    );

    expect(page).not.toBeNull();
    expect(
      ids(
        page ?? pageOf([], { hasMore: false, nextCursor: undefined }),
      ).toSorted(),
    ).toEqual(["a", "b"]);
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
      localHomeRows: [
        localRow({
          id: "a",
          recentAt: 1,
          updatedAt: 1,
          pinned: false,
          createdAt: 1,
        }),
      ],
      preservedRows: [preservedRow("b", 2, 2)],
    });
    if (contribution.kind !== "contributed") {
      throw new Error("expected a contributed read");
    }
    const page = hostLocalHistoryPage(contribution.read, "host-1");

    expect(ids(page)).toEqual(["a", "b"]);
    expect(page.completeness).toMatchObject({
      cloudPage: "unavailable",
      localRows: "present",
    });
  });
});

describe("historyCoverageIsReduced", () => {
  it("states reduced coverage for the host-only page when the pool did not answer", () => {
    const hostOnly = composeHistoryPageWithoutPool({
      contributingPeerId: "host-1",
      contribution: readOf({
        localHomeRows: [
          localRow({
            id: "a",
            recentAt: 1,
            updatedAt: 1,
            pinned: false,
            createdAt: 1,
          }),
        ],
      }),
      placement: "admit",
      sort: "recent",
      query: undefined,
    });

    expect(hostOnly?.completeness?.cloudPage).toBe("unavailable");
    expect(hostOnly?.completeness?.localRows).toBe("present");
    expect(historyCoverageIsReduced(hostOnly?.completeness ?? null)).toBe(true);
  });

  it("states no reduced coverage for a settled server page", () => {
    const settled = compose(
      pageOf([plain("a", 5)], { hasMore: false, nextCursor: undefined }),
      readOf({}),
      "admit",
    );

    expect(settled.completeness?.cloudPage).toBe("settled");
    expect(historyCoverageIsReduced(settled.completeness ?? null)).toBe(false);
  });
});
