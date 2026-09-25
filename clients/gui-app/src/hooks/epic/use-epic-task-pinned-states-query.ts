import { useCallback, useMemo } from "react";
import {
  replaceEqualDeep,
  useQueries,
  useQueryClient,
  type Query,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  GET_TASK_CONTEXTS_MAX_IDS,
  isFoundTaskContext,
  type GetTaskContextsResponse,
  type TaskContextResolution,
} from "@traycer/protocol/host/epic/unary-schemas";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import {
  useHostBinding,
  useHostClient,
  type HostRpcRegistry,
} from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import { registerCloudEpicTasksClient } from "@/lib/cloud-epic-tasks-query";
import {
  useLocalHomedOpenEpicHostIds,
  useLocalHomedOpenEpicIds,
} from "@/lib/registries/epic-session-registry";
import { epicPinReadingListQueryOptions } from "@/lib/cloud-epic-tasks-query/reconciler-local-home-query";
import {
  epicPinReadingQueryKeyMatchesScope,
  epicTaskContextsQueryKeyMatchesScope,
} from "@/lib/cloud-epic-tasks-query/cache";
import {
  CURRENT_EPIC_VERSION,
  CURRENT_PHASE_VERSION,
} from "@traycer-clients/shared/epic/epic-version";
import type { ListTasksResponse } from "@traycer/protocol/host/epic/unary-schemas";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

/**
 * What the tab strip knows about one open epic's History pin.
 *
 * `pinned` alone was the whole answer, and that is gap 4: pin is a CLOUD-ONLY
 * personal preference, a local-homed epic has no cloud row to carry one, and a
 * bare `false` is indistinguishable from "in the cloud and not pinned". So the
 * tab context menu offered Pin on a local epic, fired the mutation, and the
 * toast claimed it had pinned it.
 *
 * `home` is `undefined` when NEITHER source said - the queried host did not
 * (an older host, a pre-`@1.1` negotiation, or an epic it does not own) and no
 * live session is reporting local durability for the epic either. That reads
 * as cloud-or-unknown and keeps today's behaviour, which is the only safe
 * direction for an absence.
 *
 * The two sources are the queried host's `localHomedTaskIds` and the epic's
 * own open session, merged by {@link overlayLocalHomedPinnedStates}; read it
 * before treating this field as one host's answer.
 */
export type TaskPinnedState = {
  readonly pinned: boolean;
  readonly home: "local" | undefined;
  /**
   * The host whose disk holds this epic, when a live session says one does.
   *
   * Carried on the READING rather than looked up by the dispatch site, for the
   * same reason `home` is: the control rendered from this object, and a pin
   * write has to go to the machine whose `epicHomeVerdict` will answer `local`
   * - any other host falls through to a cloud write for an epic the cloud has
   * no row for. Resolving it separately at dispatch is how the gate and the
   * request come to mean different machines.
   *
   * `null` for a cloud-homed row and for a local-homed one whose session has no
   * serving host: both mean "follow the window", which is correct for a cloud
   * pin and refused by the admission gate for a local one.
   */
  readonly hostId: string | null;
  /**
   * Whether {@link pinned} is a READING from a host that resolved this epic,
   * rather than the `false` {@link overlayLocalHomedPinnedStates} fills in for
   * an epic only a live session knows is local-homed.
   *
   * This field exists because that filler stopped being inert.
   * `epic.setPinned@1.1` makes a local-homed row pinnable, so the tab menu no
   * longer short-circuits on `home === "local"` - and the moment it stops, an
   * unresolved epic's filler `false` becomes the thing the menu renders
   * ("Pin", for an epic that may already be pinned) and the thing a click
   * inverts. The old comment here predicted exactly that ("If a future
   * consumer reads `pinned` without consulting `home`, this value becomes
   * load-bearing and is wrong"); this is the flag that keeps it honest instead
   * of leaving the warning in prose.
   */
  readonly pinnedKnown: boolean;
};

const EMPTY_TASK_PINNED_STATES: ReadonlyMap<string, TaskPinnedState> =
  new Map();

/** Reads personal History pin state for the exact set of open task tabs. */
export function useEpicTaskPinnedStates(
  epicIds: ReadonlyArray<string>,
): ReadonlyMap<string, TaskPinnedState> {
  const client = useHostClient();
  const localHomedEpicIds = useLocalHomedOpenEpicIds(epicIds);
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  // `contextMetadata.userId` admits the local plane and is deliberately not
  // the spend gate. `epic.getTaskContexts` can reach the account's servers,
  // and the host connection does not carry the renderer's verdict - so a
  // withdrawn verdict would otherwise still spend cloud capability to paint
  // pin state on the tab strip.
  //
  // Withholding the batch under an unverified session is still right, but the
  // reason it is SAFE has changed and the old one is gone. It used to be "the
  // sole consumer announces `unverified-session` anyway", which stopped being
  // true the moment `epic.setPinned@1.1` made a local-homed row pinnable: the
  // menu's local-home arm returns before that check, so an absent entry became
  // something it does render. That comment outlived its premise for two
  // commits.
  //
  // What holds now: a local-homed row does not NEED this batch. Its pin lives
  // in the owning host's `local_epic.pinnedByUserId`, and
  // `epicPinReadingListQueryOptions` below reads it over the local-first list
  // line the unverified session is already admitted on. A cloud-homed row
  // still needs the batch, still does not get it here, and is still reported
  // `pinnedKnown: false` - honest, because for that row nothing answered.
  const cloudAuthorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const chunks = useMemo(() => taskPinReadingChunks(epicIds), [epicIds]);
  const requests = useMemo(
    () =>
      chunks.map((taskIds) => ({
        method: "epic.getTaskContexts" as const,
        params: { taskIds: [...taskIds] },
      })),
    [chunks],
  );
  // `useQueries` hands `combine` the results in request order, so each
  // result's requested ids are recoverable by index - which is what lets an id
  // the settled batch did NOT answer be told apart from one still in flight.
  const combine = useCallback(
    (results: UseQueryResult<GetTaskContextsResponse, HostRpcError>[]) =>
      combineTaskPinnedStateResults(
        results,
        requests.map((request) => request.params.taskIds),
      ),
    [requests],
  );

  const queried = useHostQueries<
    HostRpcRegistry,
    "epic.getTaskContexts",
    ReadonlyMap<string, TaskPinnedState>
  >({
    client,
    requests,
    cacheKeyIdentity: userId ?? undefined,
    preflight: cloudVerdictPreflight("epic.getTaskContexts"),
    options: {
      enabled: cloudAuthorized && userId !== null && chunks.length > 0,
      staleTime: Infinity,
      // A retry re-asks a WHOLE chunk (up to 50 ids) for the one row that was
      // unanswered, so its response replaces rows that already had an answer.
      // A TRANSIENT `unknown` for one of those must not demote it to "pin
      // state unknown" - the earlier `found` is the better reading. Only a
      // transient reason yields: `confirmed-absent` (the task is gone) and an
      // `unknown` that is an access answer (`denied`,
      // `not-found-or-not-permitted`) are real answers, and a new `found`
      // wins outright.
      structuralSharing: (previous: unknown, incoming: unknown) =>
        replaceEqualDeep(
          previous,
          keepAnsweredOverTransientUnknown(previous, incoming),
        ),
    },
    combine,
  });

  const localRows = useLocalHomedOpenTaskRows(epicIds, userId);
  const localPinReadings = localRows.pinnedStates;

  return useMemo(
    () =>
      overlayLocalHomedPinnedStates(
        queried,
        localHomedEpicIds,
        localPinReadings,
        localRows.hostIds,
      ),
    [queried, localHomedEpicIds, localPinReadings, localRows.hostIds],
  );
}

/** Local rows for open epics, read from the host holding each live session. */
export function useLocalHomedOpenTaskRows(
  epicIds: ReadonlyArray<string>,
  userId: string | null,
) {
  const binding = useHostBinding();
  const localHomedByHost = useLocalHomedOpenEpicHostIds(epicIds);
  // Each host's reading is keyed by the POPULATION it has to answer for, not by
  // the host alone, and that is R8: the params are constant and
  // `staleTime: Infinity`, so one key per host meant exactly one list RPC per
  // host for the life of the session. A local-homed epic that appeared after
  // that page - created here, created in another window, or simply learned from
  // another session - was absent from the cached response forever, and absent is
  // what `pinnedKnown: false` reports. The tab was stuck claiming nobody had
  // answered until something invalidated the cache by hand.
  //
  // Keyed on MEMBERSHIP and never on missingness, which is the distinction that
  // keeps this terminating. An epic entering the population changes the key once
  // and costs one fetch; a row the host genuinely omits (it is not that host's,
  // or it has no durable pin) is then still absent and nothing asks again on its
  // own, because the population has not changed. A policy of "refetch while some
  // open epic has no reading" would read its own output and never stop. The one
  // re-ask is demand-driven: opening that tab's menu
  // (`useRetryUnansweredTaskPinReading`), which is not an output of this query.
  const pinReadingPopulations = useMemo(() => {
    const byHost = new Map<string, Array<string>>();
    for (const [epicId, hostId] of localHomedByHost) {
      const population = byHost.get(hostId);
      if (population === undefined) byHost.set(hostId, [epicId]);
      else population.push(epicId);
    }
    return [...byHost.entries()]
      .map(([hostId, population]) => ({ hostId, population }))
      .sort((left, right) => left.hostId.localeCompare(right.hostId));
  }, [localHomedByHost]);
  const pinReadingParams = useMemo(
    () => ({
      limit: LOCAL_HOME_PIN_READING_LIMIT,
      filters: { taskType: "epic" as const },
      extensionPhaseVersion: String(CURRENT_PHASE_VERSION),
      extensionEpicVersion: String(CURRENT_EPIC_VERSION),
    }),
    [],
  );
  // The reading dispatches by HOST ID through the list module's own client
  // registry, so the owning host's client has to be IN that registry or the
  // fetch rejects with `No host client registered for <owner>` before any
  // transport is touched. Nothing else registers it for this path: the two route
  // loaders and the History hook register the WINDOW's client, and the tab
  // reconciler's all-host registration is gated on `signed-in` - which is the
  // one verdict this query exists to work without.
  //
  // Registered during render, matching `useCloudEpicTasksQuery`'s own
  // `registerCloudEpicTasksClientIfAvailable` call: the registry is a Map, the
  // write is idempotent, and it has to be in place before the query below
  // dispatches in this same pass. An effect would run after it.
  //
  // `resolveNamedHostClient` is the sanctioned binding resolver (AGENTS.md) and
  // is a plain function, which is what lets this run per host rather than one
  // `useHostClientForHostId` per component.
  for (const { hostId } of pinReadingPopulations) {
    const ownerClient = resolveNamedHostClient(binding, hostId);
    if (ownerClient !== null) {
      registerCloudEpicTasksClient(hostId, ownerClient);
    }
  }
  const combineRows = useCallback(
    (results: UseQueryResult<ListTasksResponse>[]) =>
      combineLocalTaskRows(results, pinReadingPopulations),
    [pinReadingPopulations],
  );
  const localRows = useQueries({
    queries:
      userId === null
        ? []
        : pinReadingPopulations.map(({ hostId, population }) => ({
            ...epicPinReadingListQueryOptions({
              hostId,
              userId,
              params: pinReadingParams,
              // THIS host's local-homed epics only. A population built from every
              // host would re-key - and so re-fetch - each host's reading
              // whenever any other host's tabs changed, which is a fan-out the
              // per-host shape exists to avoid.
              population,
            }),
            // NOT gated on the cloud verdict, and that is the point of using
            // this line: the local rows are synthesized from the host's own
            // registry with no cloud read, which is why an unverified session
            // may have them.
            enabled: true,
            staleTime: Infinity,
          })),
    combine: combineRows,
  });

  return {
    tasks: localRows.tasks,
    pinnedStates: localRows.pinnedStates,
    isFetching: localRows.isFetching,
    hasError: localRows.hasError,
    hostIds: localHomedByHost,
  };
}

function combineLocalTaskRows(
  results: UseQueryResult<ListTasksResponse>[],
  populations: readonly { readonly hostId: string }[],
) {
  return {
    tasks: results.flatMap((result, index) =>
      (result.data?.tasks ?? []).map((task) => ({
        task,
        hostId: populations[index].hostId,
      })),
    ),
    pinnedStates: combineLocalPinReadings(results),
    isFetching: results.some((result) => result.isFetching),
    hasError: results.some((result) => result.isError),
  };
}

/**
 * Enough rows to carry every local-homed epic the host has.
 *
 * The local rows ride the cursorless page without consuming the cloud `limit`,
 * so this number bounds the CLOUD half of the page only - the local half is
 * whole regardless. Kept small for that reason: the cloud rows fetched here are
 * incidental, and History owns the real paged read.
 */
const LOCAL_HOME_PIN_READING_LIMIT = 1;

/**
 * The durable pin for each row a host reports as `home: "local"`.
 *
 * `home` is the discriminator and the only one that is safe. A row with
 * `home: "cloud"` carries `pinned: false` as "the absence of a claim, not a
 * claim of unpinned" (the resolver's own words, for mirror and orphan rows), so
 * reading `pinned` off one of those would reintroduce exactly the false-as-an-
 * answer defect `pinnedKnown` exists to prevent. A row with `home: "local"`
 * carries `record.pinnedByUserId === userId` from the durable registry,
 * compared against the asking account - a real reading.
 */
export function combineLocalPinReadings(
  results: ReadonlyArray<
    Pick<UseQueryResult<ListTasksResponse, unknown>, "data">
  >,
): ReadonlyMap<string, boolean> {
  const readings = new Map<string, boolean>();
  for (const result of results) {
    for (const task of result.data?.tasks ?? []) {
      if (task.home !== "local") continue;
      const epicId = task.epic?.light?.id;
      if (epicId === undefined) continue;
      // `pinned` is OPTIONAL on the wire (`z.boolean().optional()`), and an
      // absent one is the same kind of silence as a cloud-homed row's `false`:
      // the host stated no pin. It must not enter the map, because membership is
      // what `pinnedKnown` reports - an `undefined` value stored here would make
      // `readings.has(epicId)` true while the reading says nothing, and the
      // overlay would then call the answer KNOWN. The observable state happened
      // to come out right through `??`, which is precisely what made this a type
      // error rather than a visible bug.
      if (task.pinned === undefined) continue;
      readings.set(epicId, task.pinned);
    }
  }
  return readings;
}

/**
 * Overlays what the open sessions know onto what the queried host answered.
 *
 * The batch above goes to the app-wide host for every open epic id. That host
 * answers `pinned` correctly whatever it is - pin is a cloud-only preference
 * and every host proxies it to the cloud - but it can only report local-home
 * for epics it OWNS (`getTaskContextsResponseSchema@1.3` overlays owned rows).
 * So a local-homed epic on another host is not resolved by the batch: it gets
 * the batch's UNANSWERED entry at best, which carries no `home` - so without
 * this overlay the menu could not tell it is local-homed at all.
 *
 * The session wins on `home` where the two are both present, deliberately. A
 * live session is the epic's own stream, and the store's own rule is that
 * where an epic is durable is a property of the EPIC rather than of whichever
 * host was asked. `pinned` is never overridden - the queried value is the
 * cloud's, which is the only thing that can answer it.
 *
 * `pinned: false` for an epic the host never resolved is FILLER, not a
 * reading, and `pinnedKnown: false` is what says so. It used to be safe by
 * accident: `TabContextMenuContent` computed `pinUnavailable` from
 * `home === "local"`, which short-circuited both the label and the spinner, so
 * nothing ever read the value. `epic.setPinned@1.1` removed that
 * short-circuit - a local-homed row is now pinnable - so the guard is the flag
 * rather than the coincidence. A consumer that reads `pinned` while
 * `pinnedKnown` is false is reading "not pinned" out of "nobody answered".
 *
 * ONLY covers epics with a live session. An open tab whose session was never
 * mounted since reload, or was pruned past the five-live MRU cap, is absent
 * from `localHomedEpicIds` and renders from the batch alone - "pin state
 * unknown" once it settles without resolving the epic, not a spinner - see
 * {@link useLocalHomedOpenEpicIds} for what telling it apart would take.
 */
export function overlayLocalHomedPinnedStates(
  queried: ReadonlyMap<string, TaskPinnedState>,
  localHomedEpicIds: ReadonlySet<string>,
  localPinReadings: ReadonlyMap<string, boolean>,
  localHomedHostIds: ReadonlyMap<string, string>,
): ReadonlyMap<string, TaskPinnedState> {
  // Identity preserved when there is nothing to overlay, so the common case
  // does not hand consumers a fresh map every render.
  if (localHomedEpicIds.size === 0) return queried;
  const overlaid = new Map(queried);
  for (const epicId of localHomedEpicIds) {
    const resolved = overlaid.get(epicId);
    const localReading = localPinReadings.get(epicId);
    // ORDERING, stated because three sources meet here and the precedence is
    // not symmetric:
    //
    // 1. `home` - the SESSION wins, unconditionally. Where an epic is durable
    //    is a property of the epic, not of whichever host was asked.
    // 2. `pinned` - the LOCAL REGISTRY wins when it answered, because for a
    //    local-homed epic it is the only authority: the cloud has no row for
    //    that epic, so a cloud answer about it would be an absence dressed as
    //    `false`. This is the reverse of the old rule ("the queried value is
    //    the cloud's, which is the only thing that can answer it"), which was
    //    correct while every pin was a cloud pin and stopped being correct when
    //    the host gained a durable local arm.
    // 3. Neither answered - the cloud batch because it is withheld or the row
    //    is not its to resolve, the list because it has not landed yet - and
    //    `pinnedKnown: false` says so. The menu renders unavailable, which is
    //    the honest state for "nobody has answered", and resolves itself when
    //    the list query settles rather than never.
    const pinned = localReading ?? resolved?.pinned ?? false;
    overlaid.set(epicId, {
      pinned,
      home: "local",
      // 4. `hostId` - from the SESSION, the only source that still knows which
      //    machine. Absent when the session has no serving host, which the pin
      //    gate then refuses rather than sending to the window's host.
      hostId: localHomedHostIds.get(epicId) ?? null,
      // `resolved?.pinnedKnown`, not `resolved !== undefined`: the batch now
      // also carries an UNANSWERED entry for an id it settled without
      // resolving, and that entry's `pinned` is filler exactly like ours.
      pinnedKnown: localReading !== undefined || resolved?.pinnedKnown === true,
    });
  }
  return overlaid;
}

/**
 * The batch's readings, plus an UNANSWERED entry for every requested id whose
 * batch has settled without resolving it.
 *
 * Absent and unanswered are different facts, and conflating them was the
 * forever-spinner: the host leaves an id out of `found` for a cloud leg that
 * hit the discovery deadline, a 5xx, a denied row or an indeterminate local
 * lookup, and a whole chunk can error - and with `staleTime: Infinity` nothing
 * asks again. An absent entry renders "still loading", so the menu spun on a
 * question nobody was answering. Absent is now reserved for an id whose batch
 * is actually in flight (or not yet enabled); a settled miss is reported as
 * `pinnedKnown: false`, which the menu renders as an unavailable reading and
 * {@link useRetryUnansweredTaskPinReading} re-asks when the menu opens.
 */
export function combineTaskPinnedStateResults(
  results: ReadonlyArray<
    Pick<
      UseQueryResult<GetTaskContextsResponse, HostRpcError>,
      "data" | "status" | "isFetching"
    >
  >,
  requestedTaskIds: ReadonlyArray<ReadonlyArray<string>>,
): ReadonlyMap<string, TaskPinnedState> {
  if (results.length === 0) return EMPTY_TASK_PINNED_STATES;
  const pinnedStates = new Map<string, TaskPinnedState>();
  for (const result of results) {
    if (result.data === undefined) continue;
    // Absent (a pre-`@1.2` host, or one that predates the key) means the host
    // did not answer, so no id is marked local and the pin action keeps
    // exactly its released behaviour. An EMPTY array is a real answer: none.
    const localHomed = result.data.localHomedTaskIds;
    const localHomedSet =
      localHomed === undefined ? null : new Set<string>(localHomed);
    for (const resolution of Object.values(result.data.tasks)) {
      if (!isFoundTaskContext(resolution)) continue;
      const task = resolution.task;
      const epicId = task.epic?.light?.id;
      if (epicId === undefined) continue;
      // Carried through rather than collapsed into the boolean. Collapsing it
      // is exactly how the tab strip lost it.
      pinnedStates.set(epicId, {
        pinned: task.pinned ?? false,
        home: localHomedSet?.has(epicId) === true ? "local" : undefined,
        // The batch cannot name a host: its `localHomedTaskIds` is merged
        // across every queried host into one flat set, so which host answered
        // is gone by the time a row is built. The overlay below supplies it
        // from the session, which is the only source that still has it.
        hostId: null,
        // The host RESOLVED this epic, so `pinned` is its answer. (`?? false`
        // above is the wire's absent-means-not-pinned, not a stand-in for a
        // missing host - a resolved task that omits the field is a real "not
        // pinned".)
        pinnedKnown: true,
      });
    }
  }
  results.forEach((result, index) => {
    // In flight (first fetch or a retry): absent, so the menu keeps its
    // spinner for a question that is being asked. Never enabled (no host, no
    // verdict yet) is absent too - nothing has been asked, but nothing has
    // failed either, and the gates that hold it resolve on their own; an
    // unverified session is labelled by the menu before this is read.
    if (result.isFetching || result.status === "pending") return;
    for (const taskId of requestedTaskIds[index] ?? []) {
      if (pinnedStates.has(taskId)) continue;
      pinnedStates.set(taskId, {
        // Filler - `pinnedKnown: false` is what says so, and no consumer may
        // read "not pinned" out of it.
        pinned: false,
        home: undefined,
        hostId: null,
        pinnedKnown: false,
      });
    }
  });
  return pinnedStates;
}

/** Whether a cached `epic.getTaskContexts` response resolved this epic. */
function taskContextsResponseAnswers(
  response: GetTaskContextsResponse | undefined,
  epicId: string,
): boolean {
  if (response === undefined) return false;
  return Object.values(response.tasks).some(
    (resolution) =>
      isFoundTaskContext(resolution) &&
      resolution.task.epic?.light?.id === epicId,
  );
}

/** Whether this `epic.getTaskContexts` key asks for exactly `chunk`'s ids. */
function taskContextsQueryAsksForChunk(
  queryKey: readonly unknown[],
  chunk: ReadonlyArray<string>,
): boolean {
  const params = queryKey[3];
  if (
    params === null ||
    typeof params !== "object" ||
    !("taskIds" in params) ||
    !Array.isArray(params.taskIds)
  ) {
    return false;
  }
  const taskIds: ReadonlyArray<unknown> = params.taskIds;
  return (
    taskIds.length === chunk.length &&
    taskIds.every((taskId, index) => taskId === chunk[index])
  );
}

/**
 * Whether a cached per-host pin-reading page carries this epic's population,
 * read off the key (`cloudQueryKeys.epicPinReading`: the sorted population sits
 * just before the trailing marker). A host's population holds only the epics
 * that host's live sessions own, so this alone selects the OWNING host's read.
 */
function pinReadingQueryAsksFor(
  queryKey: readonly unknown[],
  epicId: string,
): boolean {
  const population = queryKey[queryKey.length - 2];
  return Array.isArray(population) && population.includes(epicId);
}

/**
 * Re-asks for one tab's pin reading when the source that renders it settled
 * without an answer - called when the tab's context menu opens, which is the
 * moment the reading is needed.
 *
 * Two sources, because two authorities render the pin:
 *
 * - a CLOUD-homed row reads the window host's `epic.getTaskContexts` batch -
 *   the tab strip's OWN chunk for this epic, named exactly through
 *   {@link taskPinReadingChunks}, never another surface's title lookup that
 *   happens to contain the id;
 * - a LOCAL-homed row reads its owning host's pin-reading list page
 *   (`overlayLocalHomedPinnedStates`), and the window's batch cannot stand in
 *   for it - that host does not own the epic, so it cannot resolve it.
 *
 * Exactly one source is re-asked per row, and only a query that asks for this
 * epic AND whose cached answer does not cover it - judged by the same readers
 * the renderer uses, so a query that already answered is never re-asked.
 *
 * Demand-driven rather than a poll on purpose: an id a host keeps leaving
 * unanswered (a denied row, a cloud that stays unreachable, a local row with
 * no durable pin) would otherwise cost a round trip forever, and an open menu
 * is a bounded number of asks. This is also what keeps the pin-reading key's
 * membership-not-missingness rule terminating: that rule forbids refetching
 * because a reading is MISSING, which would read its own output; a person
 * opening a menu is not an output of the query. An in-flight fetch is joined
 * rather than restarted (`cancelRefetch: false`), and a disabled one - no
 * verdict, no host - is skipped by `refetchQueries`, which keeps each query's
 * own gate the only one.
 */
export function useRetryUnansweredTaskPinReading(
  epicIds: ReadonlyArray<string>,
): (epicId: string) => void {
  const queryClient = useQueryClient();
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  // The same chunks `useEpicTaskPinnedStates` asks in, for the same ids.
  const chunks = useMemo(() => taskPinReadingChunks(epicIds), [epicIds]);
  return useCallback(
    (epicId: string) => {
      if (userId === null) return;
      const scope = { hostId: null, userId };
      // Which authority renders this row. A pin-reading population exists
      // exactly for the local-homed epics a live session reports, which is the
      // same set the overlay marks `home: "local"` - so its presence picks the
      // owning host's read, and the window's batch is left alone: that host
      // does not own the epic, and re-asking it would spend a cloud round trip
      // on a question it cannot answer.
      const asksForPinReading = (query: Query): boolean =>
        epicPinReadingQueryKeyMatchesScope(query.queryKey, scope) &&
        pinReadingQueryAsksFor(query.queryKey, epicId);
      const stripChunk = chunks.find((chunk) => chunk.includes(epicId));
      const localHomed =
        queryClient
          .getQueryCache()
          .findAll({ type: "active", predicate: asksForPinReading }).length > 0;
      void queryClient.refetchQueries(
        {
          type: "active",
          predicate: localHomed
            ? (query) =>
                asksForPinReading(query) &&
                !combineLocalPinReadings([
                  {
                    data: queryClient.getQueryData<ListTasksResponse>(
                      query.queryKey,
                    ),
                  },
                ]).has(epicId)
            : (query) =>
                stripChunk !== undefined &&
                epicTaskContextsQueryKeyMatchesScope(query.queryKey, scope) &&
                taskContextsQueryAsksForChunk(query.queryKey, stripChunk) &&
                !taskContextsResponseAnswers(
                  queryClient.getQueryData<GetTaskContextsResponse>(
                    query.queryKey,
                  ),
                  epicId,
                ),
        },
        { cancelRefetch: false },
      );
    },
    [chunks, queryClient, userId],
  );
}

/**
 * The id chunks the tab strip's batch asks in, one per `epic.getTaskContexts`
 * request. Shared by {@link useEpicTaskPinnedStates} and
 * {@link useRetryUnansweredTaskPinReading} so the retry can name the strip's
 * OWN queries exactly: other surfaces run `epic.getTaskContexts` title
 * lookups over the same method and user, and a predicate that matched any
 * query containing the id would re-spend their cloud batches too.
 */
export function taskPinReadingChunks(
  epicIds: ReadonlyArray<string>,
): ReadonlyArray<ReadonlyArray<string>> {
  return chunkTaskIds(
    [...new Set(epicIds)].sort((left, right) => left.localeCompare(right)),
  );
}

/**
 * `unknown` reasons that are an ANSWER about access rather than a failure to
 * answer: the account lost the task, or was never shown it. Keeping an earlier
 * `found` over one of these would leave a live Pin control on a task the
 * account can no longer write, so they replace it like `confirmed-absent`.
 */
const ACCESS_ANSWER_REASONS: ReadonlySet<string> = new Set([
  "denied",
  "not-found-or-not-permitted",
]);

/** See the `structuralSharing` note in {@link useEpicTaskPinnedStates}. */
export function keepAnsweredOverTransientUnknown(
  previous: unknown,
  incoming: unknown,
): unknown {
  if (!isTaskContextsResponse(previous) || !isTaskContextsResponse(incoming)) {
    return incoming;
  }
  let tasks: Record<string, TaskContextResolution> | null = null;
  for (const [taskId, resolution] of Object.entries(incoming.tasks)) {
    // Typed as possibly absent: a record index is, whatever the record's type
    // says, and `isFoundTaskContext` takes the absence.
    const earlier: TaskContextResolution | undefined = previous.tasks[taskId];
    if (
      resolution.status !== "unknown" ||
      ACCESS_ANSWER_REASONS.has(resolution.reason) ||
      !isFoundTaskContext(earlier)
    ) {
      continue;
    }
    tasks ??= { ...incoming.tasks };
    tasks[taskId] = earlier;
  }
  return tasks === null ? incoming : { ...incoming, tasks };
}

function isTaskContextsResponse(
  value: unknown,
): value is GetTaskContextsResponse {
  return (
    value !== null &&
    typeof value === "object" &&
    "tasks" in value &&
    value.tasks !== null &&
    typeof value.tasks === "object"
  );
}

export function chunkTaskIds(
  ids: ReadonlyArray<string>,
): ReadonlyArray<ReadonlyArray<string>> {
  return Array.from(
    { length: Math.ceil(ids.length / GET_TASK_CONTEXTS_MAX_IDS) },
    (_value, index) =>
      ids.slice(
        index * GET_TASK_CONTEXTS_MAX_IDS,
        (index + 1) * GET_TASK_CONTEXTS_MAX_IDS,
      ),
  );
}
