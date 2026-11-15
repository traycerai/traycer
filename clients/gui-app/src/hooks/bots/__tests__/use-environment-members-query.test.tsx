/**
 * The member directory of one team environment as a resolver (Tracy Bots):
 * every page of the members, each asked for once the page before it names its
 * cursor; a member no answered page lists resolves to null so the conversation
 * shows their user id.
 *
 * Real hook over the page harness's fake authn: the app reads one members list
 * from authn on the person's sign-in and pages it by user id, so a roster the
 * test serves decides where each page ends. Mounted under StrictMode.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import type { EnvironmentMembersResponseV12 } from "@traycer/protocol/host/environment/contracts";
import { hashAppQueryKey } from "@/lib/query/query-key-hash";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";
import { useEnvironmentMembersPages } from "@/hooks/environment/use-environment-members-list";
import {
  useEnvironmentMembers,
  useLoadedEnvironmentMembers,
} from "@/hooks/bots/use-environment-members-query";
import {
  mountTeamPage,
  poolSource,
  resetTeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";

vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-1",
}));

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
});

const ENVIRONMENT = "env-team";

/**
 * Members a page holds: the app pages authn's one list by user id, this many
 * to a page (`configuration-members.ts`).
 */
const PAGE_SIZE = 100;

function userIdOf(index: number): string {
  return `user-${String(index).padStart(4, "0")}`;
}

function userIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => userIdOf(index));
}

function member(userId: string): EnvironmentMembersResponseV12["members"][0] {
  return {
    userId,
    displayName: `Name of ${userId}`,
    email: `${userId}@acme.test`,
    avatarUrl: null,
    effectiveRole: "viewer",
    linkedPlan: false,
    inviteState: "accepted",
    invitedAddress: null,
  };
}

function page(
  ids: readonly string[],
  nextCursor: string | null,
): EnvironmentMembersResponseV12 {
  return {
    members: ids.map(member),
    nextCursor,
    legacyRoleNoticeSeenAt: null,
    legacyMembers: [],
  };
}

/** The pages of a roster by the cursor that asks for each, the first page's null. */
function pagesOf(
  ids: readonly string[],
): Map<string | null, EnvironmentMembersResponseV12> {
  const pages = new Map<string | null, EnvironmentMembersResponseV12>();
  let cursor: string | null = null;
  for (let start = 0; start < ids.length; start += PAGE_SIZE) {
    const rows = ids.slice(start, start + PAGE_SIZE);
    const last = rows[rows.length - 1];
    pages.set(cursor, page(rows, start + PAGE_SIZE < ids.length ? last : null));
    cursor = last;
  }
  return pages;
}

/** Forty full pages, the chain a warm cache has to be followed through. */
const FORTY_PAGE_ROSTER = userIds(40 * PAGE_SIZE);
const LAST_FORTY_USER_ID = FORTY_PAGE_ROSTER[FORTY_PAGE_ROSTER.length - 1];

/** The cursors the forty-page roster's pages are asked for by, in order. */
function fortyPages(): Map<string | null, EnvironmentMembersResponseV12> {
  return pagesOf(FORTY_PAGE_ROSTER);
}

/** The roster authn answers with; a test changes it between reads. */
interface Roster {
  ids: readonly string[];
  /** A read of the list that is refused. */
  refused: boolean;
}

type ObserveMembers = (
  environmentId: string,
  gate: boolean,
) => BotMemberResolver;

function mountMembers(
  roster: Roster,
  enabled: boolean,
  /** Pages already in the cache when the hook mounts, by cursor. */
  warm: ReadonlyMap<string | null, EnvironmentMembersResponseV12>,
): MountedMembers {
  return mountObservedMembers(useEnvironmentMembers, roster, enabled, warm);
}

/** The cache-only read: `readable` is its gate, and it never asks. */
function mountLoadedMembers(
  roster: Roster,
  readable: boolean,
  warm: ReadonlyMap<string | null, EnvironmentMembersResponseV12>,
): MountedMembers {
  return mountObservedMembers(
    useLoadedEnvironmentMembers,
    roster,
    readable,
    warm,
  );
}

interface MountedMembers {
  readonly resolver: () => BotMemberResolver;
  /** The cursor of every members page read started, in order. */
  readonly cursorsAsked: () => ReadonlyArray<string | null>;
  /** Re-renders the hook with another capability gate. */
  readonly setEnabled: (next: boolean) => void;
  /** Writes pages into the cache, as answers landing elsewhere would. */
  readonly publish: (
    pages: ReadonlyMap<string | null, EnvironmentMembersResponseV12>,
  ) => Promise<void>;
  /** Refetches the first page, as an invalidation would. */
  readonly refetchFirstPage: () => Promise<void>;
  /** Every members page query the hook observes, by status. */
  readonly pageQueries: () => ReadonlyArray<{
    readonly status: string;
    readonly fetchStatus: string;
  }>;
}

/** The cursor a members page query names; undefined for any other query. */
function cursorOf(queryKey: unknown): string | null | undefined {
  const key = JSON.stringify(queryKey);
  if (!key.includes("environment.members")) return undefined;
  const match = /"cursor":(?:null|"([^"]*)")/u.exec(key);
  return match === null ? undefined : (match.at(1) ?? null);
}

function mountObservedMembers(
  observe: ObserveMembers,
  roster: Roster,
  enabled: boolean,
  warm: ReadonlyMap<string | null, EnvironmentMembersResponseV12>,
): MountedMembers {
  const harness = mountTeamPage(poolSource("viewer"), {
    "environment.list": () => ({
      environments: [
        {
          environmentId: ENVIRONMENT,
          ownerKind: "organization",
          ownerId: "team-a",
          roomId: "room-team",
          label: "Acme",
          effectiveRole: "viewer",
          kind: "team",
          hostCount: 1,
          providerHandle: "acme",
        },
      ],
    }),
    "environment.members": () => {
      if (roster.refused) throw new Error("refused");
      return page(roster.ids, null);
    },
  });
  const queryClient = harness.queryClient;
  queryClient.setDefaultOptions({
    queries: { queryKeyHashFn: hashAppQueryKey, retry: false },
  });
  const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <StrictMode>
      <harness.Wrapper>{props.children}</harness.Wrapper>
    </StrictMode>
  );
  const keys = renderHook(
    () => useEnvironmentMembersPages(ENVIRONMENT, false),
    {
      wrapper,
    },
  );
  const pageKey = keys.result.current.pageKey;
  keys.unmount();
  const publish = (
    pages: ReadonlyMap<string | null, EnvironmentMembersResponseV12>,
  ): void => {
    for (const [cursor, cached] of pages) {
      queryClient.setQueryData(pageKey(ENVIRONMENT, cursor), cached);
    }
  };
  publish(warm);
  const cursorsAsked: Array<string | null> = [];
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type === "updated" && event.action.type === "fetch") {
      const cursor = cursorOf(event.query.queryKey);
      if (cursor !== undefined) cursorsAsked.push(cursor);
    }
  });
  const { result, rerender } = renderHook(
    (props: { readonly enabled: boolean }) =>
      observe(ENVIRONMENT, props.enabled),
    { wrapper, initialProps: { enabled } },
  );
  const pageQueries = () =>
    queryClient
      .getQueryCache()
      .findAll()
      .filter(
        (query) =>
          query.getObserversCount() > 0 &&
          JSON.stringify(query.queryKey).includes("environment.members"),
      );
  return {
    resolver: () => result.current,
    cursorsAsked: () => [...cursorsAsked],
    publish: async (pages) => {
      await act(async () => {
        publish(pages);
        await Promise.resolve();
      });
    },
    setEnabled: (next) => {
      rerender({ enabled: next });
    },
    refetchFirstPage: async () => {
      const first = pageQueries().find(
        (query) => cursorOf(query.queryKey) === null,
      );
      if (first === undefined) throw new Error("no first page query");
      await act(async () => {
        await first.fetch();
      });
    },
    pageQueries: () =>
      pageQueries().map((query) => ({
        status: query.state.status,
        fetchStatus: query.state.fetchStatus,
      })),
  };
}

function rosterOf(ids: readonly string[]): Roster {
  return { ids, refused: false };
}

describe("useEnvironmentMembers", () => {
  it("asks for the next page once the first names its cursor and resolves members from both", async () => {
    const ids = userIds(PAGE_SIZE + 1);
    const mounted = mountMembers(rosterOf(ids), true, new Map());

    await waitFor(() => {
      expect(mounted.resolver()(ids[0])?.displayName).toBe(`Name of ${ids[0]}`);
      expect(mounted.resolver()(ids[PAGE_SIZE])?.displayName).toBe(
        `Name of ${ids[PAGE_SIZE]}`,
      );
    });
    expect(mounted.cursorsAsked()).toEqual([null, ids[PAGE_SIZE - 1]]);
  });

  it("sends no request while disabled and resolves nobody", () => {
    const mounted = mountMembers(rosterOf(userIds(1)), false, new Map());

    // The hook holds its first page's query, parked: disabled, never fetched.
    expect(mounted.pageQueries()).toEqual([
      { status: "pending", fetchStatus: "idle" },
    ]);
    expect(mounted.cursorsAsked()).toEqual([]);
    expect(mounted.resolver()(userIdOf(0))).toBeNull();
  });

  it("resolves nobody when a page is refused, without throwing from the hook", async () => {
    const mounted = mountMembers(
      { ids: userIds(1), refused: true },
      true,
      new Map(),
    );

    // The refused first page is the hook's last state: an error, nothing in
    // flight, and no cursor to follow.
    await waitFor(() => {
      expect(mounted.pageQueries()).toEqual([
        { status: "error", fetchStatus: "idle" },
      ]);
    });

    expect(mounted.resolver()(userIdOf(0))).toBeNull();
    expect(mounted.cursorsAsked()).toEqual([null]);
  });

  it("names nobody once the gate shuts, though the list answered before", async () => {
    const mounted = mountMembers(rosterOf(userIds(1)), true, new Map());
    await waitFor(() => {
      expect(mounted.resolver()(userIdOf(0))?.displayName).toBe(
        `Name of ${userIdOf(0)}`,
      );
    });

    mounted.setEnabled(false);

    expect(mounted.resolver()(userIdOf(0))).toBeNull();
  });

  it("follows the cursor a refetched first page names now, not the one it named before", async () => {
    const ids = userIds(PAGE_SIZE + 1);
    const roster = rosterOf(ids);
    const mounted = mountMembers(roster, true, new Map());
    await waitFor(() => {
      expect(mounted.resolver()(ids[PAGE_SIZE])?.displayName).toBe(
        `Name of ${ids[PAGE_SIZE]}`,
      );
    });

    // A member joined below the first page's end: the first page now ends
    // one earlier, and the page after it starts there.
    const joined = "user-0000-new";
    roster.ids = [ids[0], joined, ...ids.slice(1)];
    await mounted.refetchFirstPage();

    // The new first page and the new second page, which now holds the
    // member the first page's end moved off.
    await waitFor(() => {
      expect(mounted.resolver()(joined)?.displayName).toBe(`Name of ${joined}`);
      expect(mounted.resolver()(ids[PAGE_SIZE - 1])?.displayName).toBe(
        `Name of ${ids[PAGE_SIZE - 1]}`,
      );
    });
    expect(mounted.cursorsAsked()).toEqual([
      null,
      ids[PAGE_SIZE - 1],
      null,
      ids[PAGE_SIZE - 2],
    ]);
  });

  it("names nobody from a warm cache while the gate is shut", () => {
    const warm = new Map<string | null, EnvironmentMembersResponseV12>([
      [null, page(userIds(1), null)],
    ]);

    const mounted = mountMembers(rosterOf(userIds(1)), false, warm);

    expect(mounted.resolver()(userIdOf(0))).toBeNull();
    expect(mounted.cursorsAsked()).toEqual([]);
  });

  it("drops the members of a tail an earlier page no longer names", async () => {
    const ids = userIds(PAGE_SIZE + 1);
    const roster = rosterOf(ids);
    const mounted = mountMembers(roster, true, new Map());
    await waitFor(() => {
      expect(mounted.resolver()(ids[PAGE_SIZE])?.displayName).toBe(
        `Name of ${ids[PAGE_SIZE]}`,
      );
    });

    // The member past the first page left: the first page is the last now.
    roster.ids = ids.slice(0, PAGE_SIZE);
    await mounted.refetchFirstPage();

    await waitFor(() => {
      expect(mounted.resolver()(ids[PAGE_SIZE])).toBeNull();
    });
    expect(mounted.resolver()(ids[0])?.displayName).toBe(`Name of ${ids[0]}`);
  });

  it("follows a warm cache of more pages than React allows re-renders in one go", () => {
    const warm = fortyPages();

    const mounted = mountMembers(rosterOf(FORTY_PAGE_ROSTER), true, warm);

    // Every cached page is followed on mount, without the re-render limit.
    expect(mounted.resolver()(LAST_FORTY_USER_ID)?.displayName).toBe(
      `Name of ${LAST_FORTY_USER_ID}`,
    );
    expect(mounted.pageQueries()).toHaveLength(warm.size);
  });

  it("follows a cached tail a terminal first page later names, in one go", async () => {
    const tail = fortyPages();
    const terminalFirst = new Map(tail);
    terminalFirst.set(null, page(FORTY_PAGE_ROSTER.slice(0, PAGE_SIZE), null));
    const mounted = mountMembers(
      rosterOf(FORTY_PAGE_ROSTER),
      true,
      terminalFirst,
    );
    expect(mounted.pageQueries()).toHaveLength(1);

    // The first page now names the second, whose tail is all cached.
    const first = tail.get(null);
    if (first === undefined) throw new Error("no first page");
    await mounted.publish(new Map([[null, first]]));

    await waitFor(() => {
      expect(mounted.resolver()(LAST_FORTY_USER_ID)?.displayName).toBe(
        `Name of ${LAST_FORTY_USER_ID}`,
      );
    });
    expect(mounted.pageQueries()).toHaveLength(tail.size);
  });

  it("follows a cached suffix a re-routed first page leads back to, in one go", async () => {
    const pages = fortyPages();
    const roster = rosterOf(FORTY_PAGE_ROSTER);
    const mounted = mountMembers(roster, true, pages);
    expect(mounted.resolver()(LAST_FORTY_USER_ID)?.displayName).toBe(
      `Name of ${LAST_FORTY_USER_ID}`,
    );
    // The mount's own refetch of the stale cached pages has settled, so the
    // refetch below asks again rather than joining it.
    await waitFor(() => {
      expect(
        mounted.pageQueries().every((query) => query.fetchStatus === "idle"),
      ).toBe(true);
    });

    // A page of members joined ahead of everyone: the refetched first page
    // is all new members, the page after it holds the old first page's
    // members, and that page ends where the old first page did, so the rest
    // is cached.
    const joined = Array.from(
      { length: PAGE_SIZE },
      (_, index) => `user-00-new-${String(index).padStart(3, "0")}`,
    );
    roster.ids = [...joined, ...FORTY_PAGE_ROSTER];
    await mounted.refetchFirstPage();

    await waitFor(() => {
      expect(mounted.resolver()(joined[0])?.displayName).toBe(
        `Name of ${joined[0]}`,
      );
      expect(mounted.pageQueries()).toHaveLength(pages.size + 1);
    });
    expect(mounted.resolver()(LAST_FORTY_USER_ID)?.displayName).toBe(
      `Name of ${LAST_FORTY_USER_ID}`,
    );
  });

  it("follows pages that land in the cache after it mounted, in one go", async () => {
    const pages = fortyPages();
    const mounted = mountMembers(rosterOf(FORTY_PAGE_ROSTER), true, new Map());

    // Every page lands at once, after the cache was first read.
    await mounted.publish(pages);

    await waitFor(() => {
      expect(mounted.resolver()(LAST_FORTY_USER_ID)?.displayName).toBe(
        `Name of ${LAST_FORTY_USER_ID}`,
      );
    });
    expect(mounted.pageQueries()).toHaveLength(pages.size);
  });

  it("does not ask again for a cursor a later page repeats", async () => {
    const ids = userIds(PAGE_SIZE + 1);
    const mounted = mountMembers(rosterOf(ids), true, new Map());
    await waitFor(() => {
      expect(mounted.resolver()(ids[PAGE_SIZE])?.displayName).toBe(
        `Name of ${ids[PAGE_SIZE]}`,
      );
    });

    // The second page now names the cursor that asked for it.
    await mounted.publish(
      new Map([
        [ids[PAGE_SIZE - 1], page([ids[PAGE_SIZE]], ids[PAGE_SIZE - 1])],
      ]),
    );

    // Both pages are settled and no third page query exists, so nothing more
    // can be asked.
    await waitFor(() => {
      expect(mounted.pageQueries()).toEqual([
        { status: "success", fetchStatus: "idle" },
        { status: "success", fetchStatus: "idle" },
      ]);
    });
    expect(mounted.cursorsAsked()).toEqual([null, ids[PAGE_SIZE - 1]]);
  });
});

describe("useLoadedEnvironmentMembers", () => {
  /** Three chained pages, each naming the next, by the cursor that asks. */
  const THREE_PAGE_ROSTER = userIds(3 * PAGE_SIZE);
  const THREE_PAGES = pagesOf(THREE_PAGE_ROSTER);
  const FIRST_USER_ID = THREE_PAGE_ROSTER[0];
  const LAST_USER_ID = THREE_PAGE_ROSTER[THREE_PAGE_ROSTER.length - 1];
  const NO_ROSTER: Roster = { ids: [], refused: true };

  it("resolves members from every page of a warm cache without a request", async () => {
    const mounted = mountLoadedMembers(NO_ROSTER, true, THREE_PAGES);

    await waitFor(() => {
      expect(mounted.resolver()(LAST_USER_ID)?.displayName).toBe(
        `Name of ${LAST_USER_ID}`,
      );
    });
    expect(mounted.resolver()(FIRST_USER_ID)?.displayName).toBe(
      `Name of ${FIRST_USER_ID}`,
    );
    expect(mounted.cursorsAsked()).toEqual([]);
    expect(
      mounted.pageQueries().every((query) => query.fetchStatus === "idle"),
    ).toBe(true);
  });

  it("resolves nobody from a cold cache and asks for nothing", () => {
    const mounted = mountLoadedMembers(NO_ROSTER, true, new Map());

    expect(mounted.resolver()(FIRST_USER_ID)).toBeNull();
    expect(mounted.pageQueries()).toEqual([
      { status: "pending", fetchStatus: "idle" },
    ]);
    expect(mounted.cursorsAsked()).toEqual([]);
  });

  it("resolves members from pages another reader publishes later", async () => {
    const mounted = mountLoadedMembers(NO_ROSTER, true, new Map());

    await mounted.publish(THREE_PAGES);

    await waitFor(() => {
      expect(mounted.resolver()(LAST_USER_ID)?.displayName).toBe(
        `Name of ${LAST_USER_ID}`,
      );
    });
    expect(mounted.cursorsAsked()).toEqual([]);
  });

  it("resolves nobody while the caller's verdict is withheld, whatever the cache holds", () => {
    const mounted = mountLoadedMembers(NO_ROSTER, false, THREE_PAGES);

    expect(mounted.resolver()(FIRST_USER_ID)).toBeNull();
    expect(mounted.cursorsAsked()).toEqual([]);
  });
});
