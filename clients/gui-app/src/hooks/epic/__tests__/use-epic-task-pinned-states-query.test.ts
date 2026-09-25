import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  GET_TASK_CONTEXTS_MAX_IDS,
  type GetTaskContextsResponse,
  type ListTaskLight,
  type ListTasksResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  chunkTaskIds,
  combineLocalPinReadings,
  combineTaskPinnedStateResults,
  overlayLocalHomedPinnedStates,
  useRetryUnansweredTaskPinReading,
  type TaskPinnedState,
} from "@/hooks/epic/use-epic-task-pinned-states-query";
import { hostQueryKeys, queryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

function listTaskLight(epicId: string | null, pinned: boolean): ListTaskLight {
  return {
    epic: {
      light:
        epicId === null
          ? null
          : {
              id: epicId,
              title: epicId,
              initialUserPrompt: "",
              ticketCount: 0,
              specCount: 0,
              storyCount: 0,
              reviewCount: 0,
              status: "draft",
              createdAt: 0,
              updatedAt: 0,
              createdBy: "user-1",
              version: "1.0.0",
            },
      permission: null,
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
    pinned,
  };
}

function taskContexts(
  tasks: GetTaskContextsResponse["tasks"],
  localHomedTaskIds: GetTaskContextsResponse["localHomedTaskIds"],
): GetTaskContextsResponse {
  return { tasks, localHomedTaskIds };
}

describe("chunkTaskIds", () => {
  it("splits requests that exceed the task-context request limit", () => {
    const taskIds = Array.from(
      { length: GET_TASK_CONTEXTS_MAX_IDS + 1 },
      (_value, index) => `epic-${index}`,
    );

    expect(chunkTaskIds(taskIds)).toEqual([
      taskIds.slice(0, GET_TASK_CONTEXTS_MAX_IDS),
      taskIds.slice(GET_TASK_CONTEXTS_MAX_IDS),
    ]);
  });
});

describe("combineTaskPinnedStateResults", () => {
  it("returns the shared empty state when no requests are present", () => {
    const pinnedStates = combineTaskPinnedStateResults([], []);

    expect(pinnedStates).toBe(combineTaskPinnedStateResults([], []));
    expect([...pinnedStates.entries()]).toEqual([]);
  });

  it("merges found rows and skips unrequested or incomplete task entries", () => {
    // `requestedTaskIds` names only the ids that were actually FOUND here
    // ("epic-a", "epic-b"), so nothing is left over to become an UNANSWERED
    // entry - this test's whole point is the found/skip behavior, not the
    // settled-miss behavior the next `describe` covers.
    const pinnedStates = combineTaskPinnedStateResults(
      [
        {
          data: taskContexts(
            {
              first: { status: "found", task: listTaskLight("epic-a", true) },
              missing: { status: "unknown", reason: "transport" },
              incomplete: { status: "found", task: listTaskLight(null, true) },
            },
            undefined,
          ),
          status: "success",
          isFetching: false,
        },
        {
          data: taskContexts(
            {
              second: { status: "found", task: listTaskLight("epic-b", false) },
            },
            undefined,
          ),
          status: "success",
          isFetching: false,
        },
        { data: undefined, status: "success", isFetching: false },
      ],
      [["epic-a"], ["epic-b"], []],
    );

    // The map holds `TaskPinnedState`, not a bare boolean: `home` rides along
    // so a row can disable its cloud-only pin action without a second lookup.
    // No local-home set is supplied here, so `home` is absent for both.
    // `pinnedKnown` is `true` for every resolved task - the host answered.
    expect([...pinnedStates.entries()]).toEqual([
      [
        "epic-a",
        { pinned: true, home: undefined, hostId: null, pinnedKnown: true },
      ],
      [
        "epic-b",
        { pinned: false, home: undefined, hostId: null, pinnedKnown: true },
      ],
    ]);
  });

  it("marks a row local when the host's localHomedTaskIds names it", () => {
    // The populated arm: `localHomedTaskIds` is a real answer that must flip
    // `home` to `"local"` for exactly the ids it names.
    const pinnedStates = combineTaskPinnedStateResults(
      [
        {
          data: taskContexts(
            {
              first: { status: "found", task: listTaskLight("epic-a", true) },
            },
            ["epic-a"],
          ),
          status: "success",
          isFetching: false,
        },
      ],
      [["epic-a"]],
    );

    expect([...pinnedStates.entries()]).toEqual([
      [
        "epic-a",
        { pinned: true, home: "local", hostId: null, pinnedKnown: true },
      ],
    ]);
  });

  it("treats an EMPTY localHomedTaskIds as a real answer of none, not absence", () => {
    // An absent key means the host did not answer; an empty array means it
    // did, and the answer is "no task here is local-homed". Both must leave
    // `home` at `undefined`, but for different reasons - this pins the
    // second one so it cannot silently start behaving like the first.
    const pinnedStates = combineTaskPinnedStateResults(
      [
        {
          data: taskContexts(
            {
              first: { status: "found", task: listTaskLight("epic-a", true) },
            },
            [],
          ),
          status: "success",
          isFetching: false,
        },
      ],
      [["epic-a"]],
    );

    expect([...pinnedStates.entries()]).toEqual([
      [
        "epic-a",
        { pinned: true, home: undefined, hostId: null, pinnedKnown: true },
      ],
    ]);
  });
});

/**
 * The forever-spinner fix (see the module doc on `combineTaskPinnedStateResults`):
 * a requested id the batch settled WITHOUT resolving now gets an UNANSWERED
 * filler entry (`pinnedKnown: false`) rather than being left absent, so the
 * menu can tell "nobody has answered yet" from "the host answered and this
 * epic just isn't pinned". Absent is reserved for a genuinely in-flight or
 * not-yet-asked id.
 */
describe("combineTaskPinnedStateResults - unanswered vs still-in-flight", () => {
  it("marks a settled miss and an errored chunk unanswered, and leaves in-flight/idle ids absent", () => {
    const pinnedStates = combineTaskPinnedStateResults(
      [
        // Settled successfully, but only "epic-a" of the two requested ids
        // was found in this chunk's response.
        {
          data: taskContexts(
            {
              first: { status: "found", task: listTaskLight("epic-a", true) },
            },
            undefined,
          ),
          status: "success",
          isFetching: false,
        },
        // A whole chunk errored - settled, with no data at all.
        { data: undefined, status: "error", isFetching: false },
        // In flight: a first fetch, or a background refetch of a previously
        // successful query. `isFetching` alone is what keeps this out.
        { data: undefined, status: "pending", isFetching: true },
        // Never asked at all (disabled, or not yet enabled): pending and not
        // fetching.
        { data: undefined, status: "pending", isFetching: false },
      ],
      [["epic-a", "epic-b"], ["epic-c", "epic-d"], ["epic-e"], ["epic-f"]],
    );

    expect(pinnedStates.get("epic-a")).toEqual({
      pinned: true,
      home: undefined,
      hostId: null,
      pinnedKnown: true,
    });
    const unanswered = {
      pinned: false,
      home: undefined,
      hostId: null,
      pinnedKnown: false,
    };
    expect(pinnedStates.get("epic-b")).toEqual(unanswered);
    expect(pinnedStates.get("epic-c")).toEqual(unanswered);
    expect(pinnedStates.get("epic-d")).toEqual(unanswered);
    // Still in flight, or never asked - absent, so the menu keeps its
    // spinner for a question that is genuinely still open.
    expect(pinnedStates.has("epic-e")).toBe(false);
    expect(pinnedStates.has("epic-f")).toBe(false);
  });
});

/**
 * The list query has not answered yet. Every case passing this is asserting the
 * in-flight column, which is also the pre-R1 behaviour - so these are not stale
 * fixtures, they are "nobody has answered" stated explicitly.
 */
const NO_LOCAL_READINGS: ReadonlyMap<string, boolean> = new Map();

/** No session named a host - so `hostId` stays `null` and a pin follows the window. */
const NO_LOCAL_HOSTS: ReadonlyMap<string, string> = new Map();

/**
 * `combineLocalPinReadings` is the only place a row's `pinned` bit is promoted
 * to a READING, and `home` is the whole of the test: a `home: "cloud"` row
 * carries `pinned: false` as "the absence of a claim", so admitting one would
 * publish a false reading for every cloud-homed epic on the host - indetectable
 * downstream, because `pinnedKnown` would then say the answer is known.
 */
describe("combineLocalPinReadings", () => {
  function homedRow(
    epicId: string,
    pinned: boolean,
    home: "local" | "cloud" | undefined,
  ): ListTaskLight {
    return { ...listTaskLight(epicId, pinned), home };
  }

  it("reads the pin off local-homed rows and ignores cloud-homed ones", () => {
    const readings = combineLocalPinReadings([
      {
        data: {
          tasks: [
            homedRow("epic-local-pinned", true, "local"),
            homedRow("epic-local-unpinned", false, "local"),
            homedRow("epic-cloud-unpinned", false, "cloud"),
            homedRow("epic-cloud-pinned", true, "cloud"),
          ],
          hasMore: false,
        },
      },
    ]);

    expect([...readings.entries()].sort()).toEqual([
      ["epic-local-pinned", true],
      ["epic-local-unpinned", false],
    ]);
    // Not `false` for these - ABSENT, which is what keeps `pinnedKnown` false.
    expect(readings.has("epic-cloud-unpinned")).toBe(false);
    expect(readings.has("epic-cloud-pinned")).toBe(false);
  });

  it("ignores a row with no `home` at all - a `@1.5` host answering", () => {
    const readings = combineLocalPinReadings([
      {
        data: { tasks: [homedRow("epic-1", false, undefined)], hasMore: false },
      },
    ]);

    expect(readings.size).toBe(0);
  });

  it("skips a local row whose `pinned` the host OMITTED", () => {
    // `pinned` is optional on the wire. An absent one is silence, exactly like a
    // cloud-homed row's `false` - so it must not enter the map, because
    // MEMBERSHIP is what `pinnedKnown` reports downstream.
    const readings = combineLocalPinReadings([
      {
        data: {
          tasks: [
            { ...homedRow("epic-silent", false, "local"), pinned: undefined },
            homedRow("epic-stated", true, "local"),
          ],
          hasMore: false,
        },
      },
    ]);

    expect(readings.has("epic-silent")).toBe(false);
    expect(readings.get("epic-stated")).toBe(true);
  });

  it("merges every host's page and skips rows with no epic id", () => {
    const readings = combineLocalPinReadings([
      {
        data: {
          tasks: [homedRow("epic-a", true, "local"), listTaskLight(null, true)],
          hasMore: false,
        },
      },
      { data: undefined },
      { data: { tasks: [homedRow("epic-b", false, "local")], hasMore: false } },
    ]);

    expect([...readings.entries()].sort()).toEqual([
      ["epic-a", true],
      ["epic-b", false],
    ]);
  });
});

describe("overlayLocalHomedPinnedStates", () => {
  it("returns the SAME map object when there is nothing to overlay", () => {
    // Deliberate identity preservation, not merely equal content: the common
    // case (no locally-homed epics among the open tabs) must not hand
    // consumers a fresh map every render.
    const queried: ReadonlyMap<string, TaskPinnedState> = new Map([
      [
        "epic-a",
        { pinned: true, home: undefined, hostId: null, pinnedKnown: true },
      ],
    ]);

    const overlaid = overlayLocalHomedPinnedStates(
      queried,
      new Set(),
      NO_LOCAL_READINGS,
      NO_LOCAL_HOSTS,
    );

    expect(overlaid).toBe(queried);
  });

  it("adds an entry for a local-homed epic the queried host never resolved, with pinnedKnown false", () => {
    // The wrong-host gap this hook exists to close: the epic id never reached
    // the queried map at all, so `pinned` has no source and must fall back to
    // filler rather than being left absent. `pinnedKnown: false` is what
    // marks that fallback as a FILLER, not a reading - the flag `epic.set
    // Pinned@1.1` made load-bearing (lane 9 item 5): a consumer that reads
    // `pinned` while this is false is reading "nobody answered" as "not
    // pinned".
    const queried: ReadonlyMap<string, TaskPinnedState> = new Map();

    const overlaid = overlayLocalHomedPinnedStates(
      queried,
      new Set(["epic-local-only"]),
      NO_LOCAL_READINGS,
      NO_LOCAL_HOSTS,
    );

    expect([...overlaid.entries()]).toEqual([
      [
        "epic-local-only",
        { pinned: false, home: "local", hostId: null, pinnedKnown: false },
      ],
    ]);
  });

  it("keeps the queried `pinned` value while overriding `home` to local, with pinnedKnown true", () => {
    // `pinned` is a cloud-only preference the queried host answers correctly
    // regardless of ownership - only `home` is ever overridden by the
    // session's own answer. `pinnedKnown` is `true` here because the queried
    // map ALREADY had this epic - the host resolved it.
    const queried: ReadonlyMap<string, TaskPinnedState> = new Map([
      [
        "epic-both",
        { pinned: true, home: undefined, hostId: null, pinnedKnown: true },
      ],
    ]);

    const overlaid = overlayLocalHomedPinnedStates(
      queried,
      new Set(["epic-both"]),
      NO_LOCAL_READINGS,
      NO_LOCAL_HOSTS,
    );

    expect(overlaid.get("epic-both")).toEqual({
      pinned: true,
      home: "local",
      hostId: null,
      pinnedKnown: true,
    });
  });

  it("keeps pinnedKnown false when the queried entry is itself an UNANSWERED filler", () => {
    // The batch can now settle without resolving an epic and still leave an
    // entry for it - an UNANSWERED filler (`pinnedKnown: false`), not an
    // absence. Before `resolved?.pinnedKnown === true` replaced the old
    // `resolved !== undefined` check, this filler's mere PRESENCE in
    // `queried` flipped the overlay's own `pinnedKnown` to `true` - a settled
    // miss read as a known "not pinned".
    const queried: ReadonlyMap<string, TaskPinnedState> = new Map([
      [
        "epic-unanswered",
        { pinned: false, home: undefined, hostId: null, pinnedKnown: false },
      ],
    ]);

    const overlaid = overlayLocalHomedPinnedStates(
      queried,
      new Set(["epic-unanswered"]),
      NO_LOCAL_READINGS,
      new Map([["epic-unanswered", "host-owning"]]),
    );

    expect(overlaid.get("epic-unanswered")).toEqual({
      pinned: false,
      home: "local",
      hostId: "host-owning",
      pinnedKnown: false,
    });
  });

  it("leaves an epic absent from `localHomedEpicIds` exactly as queried", () => {
    const queried: ReadonlyMap<string, TaskPinnedState> = new Map([
      [
        "epic-cloud",
        { pinned: true, home: undefined, hostId: null, pinnedKnown: true },
      ],
    ]);

    const overlaid = overlayLocalHomedPinnedStates(
      queried,
      new Set(["epic-unrelated"]),
      NO_LOCAL_READINGS,
      NO_LOCAL_HOSTS,
    );

    expect(overlaid.get("epic-cloud")).toEqual({
      pinned: true,
      home: undefined,
      hostId: null,
      pinnedKnown: true,
    });
  });

  it("takes `pinned` from the LOCAL REGISTRY reading, and marks it known", () => {
    // R1. The cold unverified tab: the cloud batch is withheld, so `queried` is
    // empty and the old code answered `pinnedKnown: false` forever, which the
    // `@1.1` menu renders as permanently unavailable. The host's local arm
    // stores the pin in `local_epic.pinnedByUserId`, and the local-first list
    // line reports it as `pinned` on a `home: "local"` row - a real reading
    // from an account-scoped durable field, with no cloud read behind it.
    const overlaid = overlayLocalHomedPinnedStates(
      new Map(),
      new Set(["epic-local-only"]),
      new Map([["epic-local-only", true]]),
      new Map([["epic-local-only", "host-owning"]]),
    );

    expect(overlaid.get("epic-local-only")).toEqual({
      pinned: true,
      home: "local",
      hostId: "host-owning",
      pinnedKnown: true,
    });
  });

  it("lets the local reading WIN over a cloud answer for the same epic", () => {
    // Precedence, asserted with the two sources DISAGREEING - the only
    // arrangement that can tell which one won. For a local-homed epic the
    // registry is the authority: the cloud has no row for it, so a cloud
    // `pinned: false` there is an absence wearing a boolean. This reverses the
    // old rule, which was right while every pin was a cloud pin.
    const overlaid = overlayLocalHomedPinnedStates(
      new Map([
        [
          "epic-both",
          { pinned: false, home: undefined, hostId: null, pinnedKnown: true },
        ],
      ]),
      new Set(["epic-both"]),
      new Map([["epic-both", true]]),
      new Map([["epic-both", "host-owning"]]),
    );

    expect(overlaid.get("epic-both")?.pinned).toBe(true);
  });

  it("reads `false` from the registry as a READING, not as filler", () => {
    // The discriminating case for `pinnedKnown`, and the reason the reading is
    // a Map rather than a set of pinned ids: an unpinned local epic and an
    // unanswered one are both `pinned: false`, and only the map's KEY
    // distinguishes them. A `Set<string>` of pinned ids could not.
    const overlaid = overlayLocalHomedPinnedStates(
      new Map(),
      new Set(["epic-local-unpinned"]),
      new Map([["epic-local-unpinned", false]]),
      new Map([["epic-local-unpinned", "host-owning"]]),
    );

    expect(overlaid.get("epic-local-unpinned")).toEqual({
      pinned: false,
      home: "local",
      hostId: "host-owning",
      pinnedKnown: true,
    });
  });

  it("does not mutate the queried map it was given", () => {
    const queried: ReadonlyMap<string, TaskPinnedState> = new Map([
      [
        "epic-a",
        { pinned: false, home: undefined, hostId: null, pinnedKnown: true },
      ],
    ]);

    overlayLocalHomedPinnedStates(
      queried,
      new Set(["epic-a"]),
      NO_LOCAL_READINGS,
      NO_LOCAL_HOSTS,
    );

    expect(queried.get("epic-a")).toEqual({
      pinned: false,
      home: undefined,
      hostId: null,
      pinnedKnown: true,
    });
  });
});

/**
 * `useRetryUnansweredTaskPinReading` is the demand-driven half of the fix: it
 * re-asks only the ACTIVE `epic.getTaskContexts` queries that both ask for the
 * given epic and have not answered it, and leaves everything else alone -
 * `staleTime: Infinity` means nothing else will ever ask again on its own.
 */
describe("useRetryUnansweredTaskPinReading", () => {
  const HOST_ID = "host-retry";
  const USER_ID = "user-retry";
  const PROFILE = { userId: USER_ID, userName: "U", email: "u@example.com" };
  const CONTEXT = { userId: USER_ID, username: "U" };

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
  });

  function wrapper(
    queryClient: QueryClient,
  ): ({ children }: { readonly children: ReactNode }) => ReactNode {
    return ({ children }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
  }

  it("refetches an active query that has not answered the epic, and leaves an already-answered one alone", async () => {
    useAuthStore.getState().setSignedIn(PROFILE, CONTEXT, []);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    // This chunk asks for "epic-a" and settles without resolving it.
    const unansweredKey = hostQueryKeys.epicTaskContexts(HOST_ID, USER_ID, [
      "epic-a",
    ]);
    let unansweredFetches = 0;
    const unansweredObserver = new QueryObserver<GetTaskContextsResponse>(
      queryClient,
      {
        queryKey: unansweredKey,
        queryFn: () => {
          unansweredFetches += 1;
          return Promise.resolve(
            taskContexts(
              { missing: { status: "unknown", reason: "transport" } },
              undefined,
            ),
          );
        },
      },
    );
    const stopUnanswered = unansweredObserver.subscribe(() => undefined);
    await waitFor(() => {
      expect(unansweredObserver.getCurrentResult().isFetching).toBe(false);
    });
    expect(unansweredFetches).toBe(1);

    // This chunk asks for a DIFFERENT epic ("epic-b") and already answered
    // it - it must not be disturbed by a retry for "epic-a".
    const answeredKey = hostQueryKeys.epicTaskContexts(HOST_ID, USER_ID, [
      "epic-b",
    ]);
    let answeredFetches = 0;
    const answeredObserver = new QueryObserver<GetTaskContextsResponse>(
      queryClient,
      {
        queryKey: answeredKey,
        queryFn: () => {
          answeredFetches += 1;
          return Promise.resolve(
            taskContexts(
              {
                first: {
                  status: "found",
                  task: listTaskLight("epic-b", true),
                },
              },
              undefined,
            ),
          );
        },
      },
    );
    const stopAnswered = answeredObserver.subscribe(() => undefined);
    await waitFor(() => {
      expect(answeredObserver.getCurrentResult().isFetching).toBe(false);
    });
    expect(answeredFetches).toBe(1);

    const { result } = renderHook(() => useRetryUnansweredTaskPinReading(), {
      wrapper: wrapper(queryClient),
    });

    result.current("epic-a");

    await waitFor(() => {
      expect(unansweredFetches).toBe(2);
    });
    // The answered query never refetched, even though a retry was in flight
    // at the same time.
    expect(answeredFetches).toBe(1);

    stopUnanswered();
    stopAnswered();
  });

  it("does not refetch anything once the query already answered the epic", async () => {
    useAuthStore.getState().setSignedIn(PROFILE, CONTEXT, []);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const answeredKey = hostQueryKeys.epicTaskContexts(HOST_ID, USER_ID, [
      "epic-a",
    ]);
    let fetches = 0;
    const observer = new QueryObserver<GetTaskContextsResponse>(queryClient, {
      queryKey: answeredKey,
      queryFn: () => {
        fetches += 1;
        return Promise.resolve(
          taskContexts(
            { first: { status: "found", task: listTaskLight("epic-a", true) } },
            undefined,
          ),
        );
      },
    });
    const stop = observer.subscribe(() => undefined);
    await waitFor(() => {
      expect(observer.getCurrentResult().isFetching).toBe(false);
    });
    expect(fetches).toBe(1);

    const { result } = renderHook(() => useRetryUnansweredTaskPinReading(), {
      wrapper: wrapper(queryClient),
    });

    result.current("epic-a");

    // Nothing to refetch - give any stray microtask a chance to land, then
    // confirm the count never moved.
    await Promise.resolve();
    await Promise.resolve();
    expect(fetches).toBe(1);

    stop();
  });

  it("is a no-op with no signed-in user id", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const refetchSpy = vi.spyOn(queryClient, "refetchQueries");

    const { result } = renderHook(() => useRetryUnansweredTaskPinReading(), {
      wrapper: wrapper(queryClient),
    });

    result.current("epic-a");

    expect(refetchSpy).not.toHaveBeenCalled();
  });

  /**
   * A minimal `Omit<ListTasksRequest, "cursor">` for building a pin-reading
   * key. Its content is irrelevant to routing - only the population and the
   * scope (host/user) matter to `pinReadingQueryAsksFor` /
   * `epicPinReadingQueryKeyMatchesScope` - so one fixed shape is reused for
   * every pin-reading key in this describe block.
   */
  const PIN_READING_REQUEST = {
    limit: 1,
    filters: null,
    extensionPhaseVersion: "1",
    extensionEpicVersion: "1",
  };

  function localHomedRow(epicId: string, pinned: boolean): ListTaskLight {
    return { ...listTaskLight(epicId, pinned), home: "local" as const };
  }

  function pinReadingPage(tasks: readonly ListTaskLight[]): ListTasksResponse {
    return { tasks: [...tasks], hasMore: false };
  }

  /**
   * Local-homed routing: a live session's own pin-reading list, not the
   * window's `epic.getTaskContexts` batch, is the authority for a local-homed
   * epic - that batch does not own it and cannot resolve it. These three
   * cases pin the SELECTION between the two sources; each is built so that
   * collapsing the routing back into "check both sources for every epic"
   * (the pre-routing shape) makes it fail.
   */
  describe("routes to exactly one source per epic", () => {
    it("refetches an unanswered LOCAL pin-reading query, and leaves an unanswered getTaskContexts query for the same epic alone", async () => {
      useAuthStore.getState().setSignedIn(PROFILE, CONTEXT, []);
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });

      // The owning host's pin-reading page for a population that includes
      // "epic-l", settled without a local reading for it.
      const pinReadingKey = queryKeys.cloudEpicPinReading(
        HOST_ID,
        USER_ID,
        PIN_READING_REQUEST,
        ["epic-l"],
      );
      let pinReadingFetches = 0;
      const pinReadingObserver = new QueryObserver<ListTasksResponse>(
        queryClient,
        {
          queryKey: pinReadingKey,
          queryFn: () => {
            pinReadingFetches += 1;
            return Promise.resolve(pinReadingPage([]));
          },
        },
      );
      const stopPinReading = pinReadingObserver.subscribe(() => undefined);
      await waitFor(() => {
        expect(pinReadingObserver.getCurrentResult().isFetching).toBe(false);
      });
      expect(pinReadingFetches).toBe(1);

      // The window's cloud batch also asks for "epic-l" (the same tab's
      // reading is requested from both places before the routing knows which
      // one owns it) and also settles without answering it. If routing were
      // removed - both sources checked for every epic - this one would also
      // refetch.
      const taskContextsKey = hostQueryKeys.epicTaskContexts(HOST_ID, USER_ID, [
        "epic-l",
      ]);
      let taskContextsFetches = 0;
      const taskContextsObserver = new QueryObserver<GetTaskContextsResponse>(
        queryClient,
        {
          queryKey: taskContextsKey,
          queryFn: () => {
            taskContextsFetches += 1;
            return Promise.resolve(
              taskContexts(
                { missing: { status: "unknown", reason: "transport" } },
                undefined,
              ),
            );
          },
        },
      );
      const stopTaskContexts = taskContextsObserver.subscribe(() => undefined);
      await waitFor(() => {
        expect(taskContextsObserver.getCurrentResult().isFetching).toBe(false);
      });
      expect(taskContextsFetches).toBe(1);

      const { result } = renderHook(() => useRetryUnansweredTaskPinReading(), {
        wrapper: wrapper(queryClient),
      });

      result.current("epic-l");

      await waitFor(() => {
        expect(pinReadingFetches).toBe(2);
      });
      // The getTaskContexts query never refetched, even though it also asks
      // for "epic-l" and also lacks an answer for it.
      expect(taskContextsFetches).toBe(1);

      stopPinReading();
      stopTaskContexts();
    });

    it("does not refetch anything once the local pin-reading answers the epic, even with an unanswered getTaskContexts query for it", async () => {
      useAuthStore.getState().setSignedIn(PROFILE, CONTEXT, []);
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });

      const pinReadingKey = queryKeys.cloudEpicPinReading(
        HOST_ID,
        USER_ID,
        PIN_READING_REQUEST,
        ["epic-l2"],
      );
      let pinReadingFetches = 0;
      const pinReadingObserver = new QueryObserver<ListTasksResponse>(
        queryClient,
        {
          queryKey: pinReadingKey,
          queryFn: () => {
            pinReadingFetches += 1;
            return Promise.resolve(
              pinReadingPage([localHomedRow("epic-l2", true)]),
            );
          },
        },
      );
      const stopPinReading = pinReadingObserver.subscribe(() => undefined);
      await waitFor(() => {
        expect(pinReadingObserver.getCurrentResult().isFetching).toBe(false);
      });
      expect(pinReadingFetches).toBe(1);

      // Deliberately still unanswered for "epic-l2" - if routing were
      // removed and both sources checked unconditionally, this would
      // refetch even though the epic is local-homed and already known.
      const taskContextsKey = hostQueryKeys.epicTaskContexts(HOST_ID, USER_ID, [
        "epic-l2",
      ]);
      let taskContextsFetches = 0;
      const taskContextsObserver = new QueryObserver<GetTaskContextsResponse>(
        queryClient,
        {
          queryKey: taskContextsKey,
          queryFn: () => {
            taskContextsFetches += 1;
            return Promise.resolve(
              taskContexts(
                { missing: { status: "unknown", reason: "transport" } },
                undefined,
              ),
            );
          },
        },
      );
      const stopTaskContexts = taskContextsObserver.subscribe(() => undefined);
      await waitFor(() => {
        expect(taskContextsObserver.getCurrentResult().isFetching).toBe(false);
      });
      expect(taskContextsFetches).toBe(1);

      const { result } = renderHook(() => useRetryUnansweredTaskPinReading(), {
        wrapper: wrapper(queryClient),
      });

      result.current("epic-l2");

      // Nothing to refetch on either side - give any stray microtask a
      // chance to land, then confirm neither count moved.
      await Promise.resolve();
      await Promise.resolve();
      expect(pinReadingFetches).toBe(1);
      expect(taskContextsFetches).toBe(1);

      stopPinReading();
      stopTaskContexts();
    });

    it("refetches an unanswered CLOUD getTaskContexts query, and leaves an unrelated active pin-reading query alone", async () => {
      useAuthStore.getState().setSignedIn(PROFILE, CONTEXT, []);
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });

      // "epic-c" is cloud-homed: no pin-reading population anywhere names it.
      const taskContextsKey = hostQueryKeys.epicTaskContexts(HOST_ID, USER_ID, [
        "epic-c",
      ]);
      let taskContextsFetches = 0;
      const taskContextsObserver = new QueryObserver<GetTaskContextsResponse>(
        queryClient,
        {
          queryKey: taskContextsKey,
          queryFn: () => {
            taskContextsFetches += 1;
            return Promise.resolve(
              taskContexts(
                { missing: { status: "unknown", reason: "transport" } },
                undefined,
              ),
            );
          },
        },
      );
      const stopTaskContexts = taskContextsObserver.subscribe(() => undefined);
      await waitFor(() => {
        expect(taskContextsObserver.getCurrentResult().isFetching).toBe(false);
      });
      expect(taskContextsFetches).toBe(1);

      // An unrelated LOCAL epic's pin-reading query, also unanswered - present
      // only to prove the cloud retry does not sweep it up. If the routing
      // predicate dropped its per-epic population check, this would refetch
      // too.
      const pinReadingKey = queryKeys.cloudEpicPinReading(
        HOST_ID,
        USER_ID,
        PIN_READING_REQUEST,
        ["epic-other"],
      );
      let pinReadingFetches = 0;
      const pinReadingObserver = new QueryObserver<ListTasksResponse>(
        queryClient,
        {
          queryKey: pinReadingKey,
          queryFn: () => {
            pinReadingFetches += 1;
            return Promise.resolve(pinReadingPage([]));
          },
        },
      );
      const stopPinReading = pinReadingObserver.subscribe(() => undefined);
      await waitFor(() => {
        expect(pinReadingObserver.getCurrentResult().isFetching).toBe(false);
      });
      expect(pinReadingFetches).toBe(1);

      const { result } = renderHook(() => useRetryUnansweredTaskPinReading(), {
        wrapper: wrapper(queryClient),
      });

      result.current("epic-c");

      await waitFor(() => {
        expect(taskContextsFetches).toBe(2);
      });
      // The unrelated pin-reading query never refetched.
      expect(pinReadingFetches).toBe(1);

      stopTaskContexts();
      stopPinReading();
    });
  });
});
