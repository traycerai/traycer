import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  GET_TASK_CONTEXTS_MAX_IDS,
  isFoundTaskContext,
  type GetTaskContextsResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useLocalHomedOpenEpicIds } from "@/lib/registries/epic-session-registry";
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
  // Withholding the batch is safe HERE specifically because the sole consumer
  // does not read an absent entry as "not pinned": `tabPinUnavailableReason`
  // answers `unverified-session` on the same verdict and the item announces
  // itself unavailable. The LOCAL half is unaffected - `localHomedEpicIds`
  // comes from the live-session registry, not from this query - so a
  // local-homed tab keeps its `home: "local"` reading through the overlay.
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

  return useMemo(
    () => overlayLocalHomedPinnedStates(queried, localHomedEpicIds),
    [queried, localHomedEpicIds],
  );
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
 * the epic is stored on this device.
 *
 * The session wins on `home` where the two are both present, deliberately. A
 * live session is the epic's own stream, and the store's own rule is that
 * where an epic is durable is a property of the EPIC rather than of whichever
 * host was asked. `pinned` is never overridden - the queried value is the
 * cloud's, which is the only thing that can answer it.
 *
 * `pinned: false` for an epic the host never resolved is FILLER, not a
 * reading, and it is never rendered: `TabContextMenuContent` computes
 * `pinUnavailable` from `home === "local"`, and that flag short-circuits both
 * the label (`pinActionLabel` ignores `taskPinned` when unavailable) and the
 * spinner (`!pinUnavailable && ...`), while `disabled` is already true. If a
 * future consumer reads `pinned` without consulting `home`, this value becomes
 * load-bearing and is wrong - such a consumer must treat `home === "local"` as
 * "there is no pin state" rather than as "not pinned".
 *
 * ONLY covers epics with a live session. An open tab whose session was never
 * mounted since reload, or was pruned past the five-live MRU cap, is absent
 * from `localHomedEpicIds` and keeps today's spinner - see
 * {@link useLocalHomedOpenEpicIds} for what closing that residual would take.
 */
export function overlayLocalHomedPinnedStates(
  queried: ReadonlyMap<string, TaskPinnedState>,
  localHomedEpicIds: ReadonlySet<string>,
): ReadonlyMap<string, TaskPinnedState> {
  // Identity preserved when there is nothing to overlay, so the common case
  // does not hand consumers a fresh map every render.
  if (localHomedEpicIds.size === 0) return queried;
  const overlaid = new Map(queried);
  for (const epicId of localHomedEpicIds) {
    overlaid.set(epicId, {
      pinned: overlaid.get(epicId)?.pinned ?? false,
      home: "local",
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
