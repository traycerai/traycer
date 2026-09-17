import { useMemo } from "react";
import { useQueries, type UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  GET_TASK_CONTEXTS_MAX_IDS,
  isFoundTaskContext,
  type GetTaskContextsResponse,
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
  const binding = useHostBinding();
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
  const normalizedIds = useMemo(
    () =>
      [...new Set(epicIds)].sort((left, right) => left.localeCompare(right)),
    [epicIds],
  );
  const requests = useMemo(
    () =>
      chunkTaskIds(normalizedIds).map((taskIds) => ({
        method: "epic.getTaskContexts" as const,
        params: { taskIds: [...taskIds] },
      })),
    [normalizedIds],
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
      enabled: cloudAuthorized && userId !== null && normalizedIds.length > 0,
      staleTime: Infinity,
    },
    combine: combineTaskPinnedStateResults,
  });

  // One cursorless `epic.listTasks` per host that owns a local-homed open tab,
  // re-asked when that host's local-homed population changes. Usually one host,
  // often zero; the hosts come from the epics' own sessions, so this never fans
  // out across the whole directory the way the tab reconciler deliberately does.
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
  // or it has no durable pin) is then still absent and nothing asks again,
  // because the population has not changed. A policy of "refetch while some open
  // epic has no reading" would read its own output and never stop.
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
  const localPinReadings = useQueries({
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
    combine: combineLocalPinReadings,
  });

  return useMemo(
    () =>
      overlayLocalHomedPinnedStates(
        queried,
        localHomedEpicIds,
        localPinReadings,
        localHomedByHost,
      ),
    [queried, localHomedEpicIds, localPinReadings, localHomedByHost],
  );
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
 * So a local-homed epic on another host is not resolved at all: no entry, and
 * the tab strip's Pin item stays disabled behind a spinner instead of saying
 * the epic is stored on the connected device.
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
 * from `localHomedEpicIds` and keeps today's spinner - see
 * {@link useLocalHomedOpenEpicIds} for what closing that residual would take.
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
      pinnedKnown: localReading !== undefined || resolved !== undefined,
    });
  }
  return overlaid;
}

export function combineTaskPinnedStateResults(
  results: ReadonlyArray<
    Pick<UseQueryResult<GetTaskContextsResponse, HostRpcError>, "data">
  >,
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
  return pinnedStates;
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
