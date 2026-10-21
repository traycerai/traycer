/**
 * The member directory of one team environment as a resolver (Tracy Bots):
 * every page of `environment.members`, each asked for once the page before it
 * names its cursor; a member no answered page lists resolves to null so the
 * conversation shows their user id.
 *
 * Real hook over a mock messenger whose handler answers (or refuses) a page,
 * mounted under StrictMode.
 */
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, type ReactNode } from "react";
import {
  HostClient,
  type HostRequester,
} from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { EnvironmentMembersResponse } from "@traycer/protocol/host/environment/contracts";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { queryKeys } from "@/lib/query-keys";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";
import { useEnvironmentMembers } from "@/hooks/bots/use-environment-members-query";

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: (client: HostRequester<HostRpcRegistry> | null) => {
    const hostId = client === null ? null : client.getActiveHostId();
    return {
      hostId,
      requestContextUserId: "user-1",
      isReady: hostId !== null,
      hasRpcEndpoint: hostId !== null,
      canExecute: hostId !== null,
    };
  },
}));

const ENVIRONMENT = "env-team";

function page(
  userId: string,
  nextCursor: string | null,
): EnvironmentMembersResponse {
  return {
    members: [{ userId, displayName: `Name of ${userId}`, avatarUrl: null }],
    nextCursor,
  };
}

const FORTY_USER_IDS = Array.from(
  { length: 40 },
  (_, index) => `user-${String(index).padStart(3, "0")}`,
);

/** Forty chained pages of one member each, by the cursor that asks for them. */
function fortyPages(): Map<string | null, EnvironmentMembersResponse> {
  return new Map(
    FORTY_USER_IDS.map((userId, index) => [
      index === 0 ? null : FORTY_USER_IDS[index - 1],
      page(userId, index === FORTY_USER_IDS.length - 1 ? null : userId),
    ]),
  );
}

const LAST_FORTY_USER_ID = FORTY_USER_IDS[FORTY_USER_IDS.length - 1];

function mountMembers(
  answerPage: (cursor: string | null) => EnvironmentMembersResponse,
  enabled: boolean,
  /** Pages already in the cache when the hook mounts, by cursor. */
  warm: ReadonlyMap<string | null, EnvironmentMembersResponse>,
): {
  readonly resolver: () => BotMemberResolver;
  readonly cursorsAsked: () => ReadonlyArray<string | null>;
  /** Re-renders the hook with another capability gate. */
  readonly setEnabled: (next: boolean) => void;
  /** Writes pages into the cache, as answers landing elsewhere would. */
  readonly publish: (
    pages: ReadonlyMap<string | null, EnvironmentMembersResponse>,
  ) => Promise<void>;
  /** Refetches the first page, as an invalidation would. */
  readonly refetchFirstPage: () => Promise<void>;
  /** Every `environment.members` page query the hook observes, by status. */
  readonly pageQueries: () => ReadonlyArray<{
    readonly status: string;
    readonly fetchStatus: string;
  }>;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const publish = (
    pages: ReadonlyMap<string | null, EnvironmentMembersResponse>,
  ): void => {
    for (const [cursor, cached] of pages) {
      queryClient.setQueryData(
        queryKeys.hostMethod<HostRpcRegistry, "environment.members">(
          mockLocalHostEntry.hostId,
          "environment.members",
          { environmentId: ENVIRONMENT, cursor },
        ),
        cached,
      );
    }
  };
  publish(warm);
  const cursorsAsked: Array<string | null> = [];
  let seq = 0;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => `req-${String(++seq)}`,
    handlers: {
      "environment.members": ({ cursor }) => {
        cursorsAsked.push(cursor);
        return answerPage(cursor);
      },
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = spine.createRequester(mockLocalHostEntry);
  const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    </StrictMode>
  );
  const { result, rerender } = renderHook(
    (props: { readonly enabled: boolean }) =>
      useEnvironmentMembers(client, ENVIRONMENT, props.enabled),
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
      const first = pageQueries().find((query) =>
        JSON.stringify(query.queryKey).includes('"cursor":null'),
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

describe("useEnvironmentMembers", () => {
  it("asks for the next page once the first names its cursor and resolves members from both", async () => {
    const mounted = mountMembers(
      (cursor) =>
        cursor === null ? page("user-a", "user-a") : page("user-b", null),
      true,
      new Map(),
    );

    await waitFor(() => {
      expect(mounted.resolver()("user-a")?.displayName).toBe("Name of user-a");
      expect(mounted.resolver()("user-b")?.displayName).toBe("Name of user-b");
    });
    expect(mounted.cursorsAsked()).toEqual([null, "user-a"]);
  });

  it("sends no request while disabled and resolves nobody", () => {
    const mounted = mountMembers(() => page("user-a", null), false, new Map());

    // The hook holds its first page's query, parked: disabled, never fetched.
    expect(mounted.pageQueries()).toEqual([
      { status: "pending", fetchStatus: "idle" },
    ]);
    expect(mounted.cursorsAsked()).toEqual([]);
    expect(mounted.resolver()("user-a")).toBeNull();
  });

  it("resolves nobody when a page is refused, without throwing from the hook", async () => {
    const mounted = mountMembers(
      () => {
        throw new Error("refused");
      },
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

    expect(mounted.resolver()("user-a")).toBeNull();
    expect(mounted.cursorsAsked()).toEqual([null]);
  });

  it("names nobody once the host stops answering the method, though it answered before", async () => {
    const mounted = mountMembers(() => page("user-a", null), true, new Map());
    await waitFor(() => {
      expect(mounted.resolver()("user-a")?.displayName).toBe("Name of user-a");
    });

    mounted.setEnabled(false);

    expect(mounted.resolver()("user-a")).toBeNull();
  });

  it("follows the cursor a refetched first page names now, not the one it named before", async () => {
    let firstPageEndsAt = "user-b";
    const mounted = mountMembers(
      (cursor) => {
        if (cursor === null) return page("user-a", firstPageEndsAt);
        if (cursor === "user-a") return page("user-b", null);
        return page("user-c", null);
      },
      true,
      new Map(),
    );
    await waitFor(() => {
      expect(mounted.resolver()("user-c")?.displayName).toBe("Name of user-c");
    });

    // A member joined below the first page's end: the first page now ends
    // one earlier, and the page after it starts there.
    firstPageEndsAt = "user-a";
    await mounted.refetchFirstPage();

    await waitFor(() => {
      expect(mounted.resolver()("user-b")?.displayName).toBe("Name of user-b");
    });
    expect(mounted.cursorsAsked()).toEqual([null, "user-b", null, "user-a"]);
  });

  it("names nobody from a warm cache while the host cannot answer the method", () => {
    const warm = new Map<string | null, EnvironmentMembersResponse>([
      [null, page("user-a", null)],
    ]);

    const mounted = mountMembers(() => page("user-a", null), false, warm);

    expect(mounted.resolver()("user-a")).toBeNull();
    expect(mounted.cursorsAsked()).toEqual([]);
  });

  it("drops the members of a tail an earlier page no longer names", async () => {
    let firstPageIsLast = false;
    const mounted = mountMembers(
      (cursor) =>
        cursor === null
          ? page("user-a", firstPageIsLast ? null : "user-a")
          : page("user-b", null),
      true,
      new Map(),
    );
    await waitFor(() => {
      expect(mounted.resolver()("user-b")?.displayName).toBe("Name of user-b");
    });

    // The member past the first page left: the first page is the last now.
    firstPageIsLast = true;
    await mounted.refetchFirstPage();

    await waitFor(() => {
      expect(mounted.resolver()("user-b")).toBeNull();
    });
    expect(mounted.resolver()("user-a")?.displayName).toBe("Name of user-a");
  });

  it("follows a warm cache of more pages than React allows re-renders in one go", () => {
    const warm = fortyPages();

    const mounted = mountMembers(
      (cursor) => warm.get(cursor) ?? page("unknown", null),
      true,
      warm,
    );

    // Every cached page is followed on mount, without the re-render limit.
    expect(mounted.resolver()(LAST_FORTY_USER_ID)?.displayName).toBe(
      `Name of ${LAST_FORTY_USER_ID}`,
    );
    expect(mounted.pageQueries()).toHaveLength(FORTY_USER_IDS.length);
  });

  it("follows a cached tail a terminal first page later names, in one go", async () => {
    const tail = fortyPages();
    const terminalFirst = new Map(tail);
    terminalFirst.set(null, page(FORTY_USER_IDS[0], null));
    const mounted = mountMembers(
      (cursor) => tail.get(cursor) ?? page("unknown", null),
      true,
      terminalFirst,
    );
    expect(mounted.pageQueries()).toHaveLength(1);

    // The first page now names the second, whose tail is all cached.
    await mounted.publish(new Map([[null, tail.get(null) ?? page("x", null)]]));

    await waitFor(() => {
      expect(mounted.resolver()(LAST_FORTY_USER_ID)?.displayName).toBe(
        `Name of ${LAST_FORTY_USER_ID}`,
      );
    });
    expect(mounted.pageQueries()).toHaveLength(FORTY_USER_IDS.length);
  });

  it("follows a cached suffix a re-routed first page leads back to, in one go", async () => {
    const pages = fortyPages();
    let rerouted = false;
    const mounted = mountMembers(
      (cursor) => {
        if (cursor === null && rerouted) return page("user-new", "user-new");
        // The page after the new members ends where the old first page did.
        if (cursor === "user-new") return page("user-new-2", FORTY_USER_IDS[0]);
        return pages.get(cursor) ?? page("unknown", null);
      },
      true,
      pages,
    );
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

    // Members joined ahead of everyone: the refetched first page now leads
    // through one uncached page into the old pages, all still cached.
    rerouted = true;
    await mounted.refetchFirstPage();

    await waitFor(() => {
      expect(mounted.resolver()("user-new-2")?.displayName).toBe(
        "Name of user-new-2",
      );
      expect(mounted.pageQueries()).toHaveLength(FORTY_USER_IDS.length + 1);
    });
    expect(mounted.resolver()(LAST_FORTY_USER_ID)?.displayName).toBe(
      `Name of ${LAST_FORTY_USER_ID}`,
    );
  });

  it("follows pages that land in the cache after it mounted, in one go", async () => {
    const pages = fortyPages();
    const mounted = mountMembers(
      (cursor) => pages.get(cursor) ?? page("unknown", null),
      true,
      new Map(),
    );

    // Every page lands at once, after the cache was first read.
    await mounted.publish(pages);

    await waitFor(() => {
      expect(mounted.resolver()(LAST_FORTY_USER_ID)?.displayName).toBe(
        `Name of ${LAST_FORTY_USER_ID}`,
      );
    });
    expect(mounted.pageQueries()).toHaveLength(FORTY_USER_IDS.length);
  });

  it("does not ask again for a cursor a later page repeats", async () => {
    const mounted = mountMembers(
      (cursor) =>
        cursor === null ? page("user-a", "user-a") : page("user-b", "user-a"),
      true,
      new Map(),
    );

    // The second page answered and its render followed it: both pages are
    // settled and no third page query exists, so nothing more can be asked.
    await waitFor(() => {
      expect(mounted.resolver()("user-b")?.displayName).toBe("Name of user-b");
      expect(mounted.pageQueries()).toEqual([
        { status: "success", fetchStatus: "idle" },
        { status: "success", fetchStatus: "idle" },
      ]);
    });

    expect(mounted.cursorsAsked()).toEqual([null, "user-a"]);
  });
});
