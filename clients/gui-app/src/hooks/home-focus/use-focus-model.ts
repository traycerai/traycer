import { useMemo, useState } from "react";
import { HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP } from "@traycer/protocol/host/notifications/contracts";
import type { ListTaskLight } from "@traycer/protocol/host/epic/unary-schemas";
import { useAgentActivityStore } from "@/stores/agent-activity-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useConnectableHostIds } from "@/hooks/host/use-connectable-host-ids";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useEpicGetTaskContexts } from "@/hooks/epic/use-epic-get-task-contexts-query";
import { useNotificationFeedMode } from "@/lib/notifications/notification-feed-mode";
import { useNotificationIndicators } from "@/hooks/notifications/use-notification-indicators-query";
import { useMergedNotificationRows } from "@/stores/notifications/merged-notifications";
import {
  buildFocusModel,
  EMPTY_FOCUS_MODEL,
} from "@/lib/home-focus/build-focus-model";
import { compareAscending } from "@/lib/home-focus/focus-identity";
import type { FocusModel } from "@/lib/home-focus/focus-model";
import { pendingPromptEpicIds } from "@/lib/home-focus/focus-prompts";
import type { FocusBackgroundChat } from "@/lib/home-focus/focus-background";
import {
  useMountedEpicProjection,
  type MountedEpicRef,
} from "@/hooks/home-focus/use-mounted-epic-projection";
import { useWarmChatBackground } from "@/hooks/home-focus/use-warm-chat-background";

/**
 * Per-hook-instance memory of the last model built, so an unchanged section
 * keeps its row objects across a rebuild triggered by a different section.
 * Keyed by a token the hook owns, so two Home surfaces in one window do not
 * share (and reset) each other's baseline, and the entry dies with the token.
 */
const focusModelCache = new WeakMap<object, FocusModel>();

/**
 * The Home focus view's whole data contract, joined from the stores this client
 * already runs. No RPC of its own beyond two batched reads (task titles by id,
 * and the host's per-epic indicator flags), and no protocol change.
 *
 * ## Hook-count stability
 *
 * The number of tasks and warm chats changes as agents start, tiles open and
 * the session cap evicts - so nothing here may call a hook per row. Every
 * dynamic set is read through ONE subscription that publishes a value-comparable
 * snapshot: `useMountedEpicProjection` for names and parentage,
 * `useWarmChatBackground` for shells and background items,
 * `useEpicGetTaskContexts` for titles (which batches ids into cap-sized
 * requests inside a single `useHostQueries`).
 *
 * ## Task titles and their staleness
 *
 * Two sources, in this precedence:
 *
 * 1. A MOUNTED epic's live Y.Doc title, which is what the tab strip shows and
 *    updates the instant someone renames the task.
 * 2. The cloud task index (`epic.getTaskContexts`, five-minute stale window).
 *
 * Which means a title here can be BEHIND for a task not open in this window,
 * and ABSENT for a brand-new task the cloud index has not published yet -
 * `null`, not a placeholder. Rendering an id is honest; inventing "Untitled" as
 * if it were the task's name is not. Not `useHistoryQuery`, the app's other
 * title reader: it resolves a SEARCH PAGE (with debouncing, local fuzzy ranking
 * and worktree probes) and would answer for the epics that happen to be on the
 * current page rather than the epics that are actually running.
 * `useEpicGetTaskContexts` is the by-id primitive `useHistoryQuery` itself uses
 * for exactly this, and it is documented as the presentation-only title reader.
 *
 * ## The indicator batch cap
 *
 * `host.notifications.indicatorState` is capped at
 * `HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP` ids per request, and the query hook
 * pages beyond it by issuing MORE requests. This surface asks about at most one
 * page: an install with more than 500 simultaneously-running tasks would
 * otherwise fan out an unbounded number of RPCs to decorate rows nobody can
 * read. Epics past the cap still resolve `needsYou` from a loaded prompt row -
 * they lose only the host's flags for a prompt this client has not paged in.
 * The ids are sorted before slicing so the covered set is stable rather than
 * re-drawn on every frame.
 */
export function useFocusModel(): FocusModel {
  const byEpic = useAgentActivityStore((state) => state.byEpic);
  const connectionStatus = useAgentActivityStore(
    (state) => state.connectionStatus,
  );
  const cloudSyncStatus = useAgentActivityStore(
    (state) => state.cloudSyncStatus,
  );
  const stateFrameSeenThisEpoch = useAgentActivityStore(
    (state) => state.stateFrameSeenThisEpoch,
  );
  const notificationRows = useMergedNotificationRows();
  const feedMode = useNotificationFeedMode();
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const warmChats = useWarmChatBackground();
  const activeHostId = useEffectiveHostId();
  const connectableHosts = useConnectableHostIds();

  // Every derived id list is memoized on a JOINED KEY rather than on the store
  // value it came from, and that indirection is the point: `notificationRows`
  // is re-minted on any notification frame and `byEpic` on any activity frame,
  // so memoizing directly on them re-mints an equal-content array several times
  // a minute - which re-subscribes the projection, re-keys the task-context
  // query and re-encodes the whole snapshot for no change at all. A string is
  // cheap to build and compares by value, so the arrays below keep their
  // identity for as long as their CONTENTS do.
  const activeEpicIdsKey = useMemo(
    () => joinIds(workingEpicIds(byEpic)),
    [byEpic],
  );
  const promptEpicIdsKey = useMemo(
    () => joinIds(pendingPromptEpicIds(notificationRows)),
    [notificationRows],
  );
  const warmEpicIdsKey = useMemo(
    () => joinIds(new Set(warmChats.map((chat) => chat.epicId))),
    [warmChats],
  );
  // Titles are needed for every epic the page can name: the running tasks, the
  // tasks a prompt points at, and the tasks whose warm chats contribute
  // background rows.
  const titleEpicIds = useMemo(
    () => unionIds([activeEpicIdsKey, promptEpicIdsKey, warmEpicIdsKey]),
    [activeEpicIdsKey, promptEpicIdsKey, warmEpicIdsKey],
  );
  const indicatorEpicIds = useMemo(
    () =>
      unionIds([activeEpicIdsKey, promptEpicIdsKey]).slice(
        0,
        HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP,
      ),
    [activeEpicIdsKey, promptEpicIdsKey],
  );
  const agentRefsKey = useMemo(
    () =>
      titleEpicIds
        .map((epicId) =>
          [epicId, joinIds(byEpic.get(epicId)?.working ?? EMPTY_ID_SET)].join(
            ID_GROUP_SEPARATOR,
          ),
        )
        .join(ID_GROUP_LIST_SEPARATOR),
    [titleEpicIds, byEpic],
  );
  const agentRefs = useMemo<ReadonlyArray<MountedEpicRef>>(
    () => decodeAgentRefs(agentRefsKey),
    [agentRefsKey],
  );

  const taskContexts = useEpicGetTaskContexts(titleEpicIds, userId);
  const projection = useMountedEpicProjection(agentRefs);
  // Epic ids only, so the app-wide active host is the right one to ask: an Epic
  // is a shared cloud entity, not a host-owned record.
  const indicators = useNotificationIndicators({
    hostId: null,
    epicIds: indicatorEpicIds,
    chatIds: [],
    enabled: indicatorEpicIds.length > 0,
  });

  const taskTitles = useMemo(
    () => mergeTaskTitles(taskContexts.tasksById, projection.liveTitles),
    [taskContexts.tasksById, projection.liveTitles],
  );
  const coldEpicHostIds = useMemo(
    () => singleHostTaskIds(taskContexts.tasksById),
    [taskContexts.tasksById],
  );
  const reachableHostIds = useMemo(
    () => new Set(connectableHosts.hostIds),
    [connectableHosts.hostIds],
  );
  const backgroundChats = useMemo<ReadonlyArray<FocusBackgroundChat>>(
    () =>
      warmChats.map((chat) => ({
        ...chat,
        taskTitle: taskTitles.get(chat.epicId) ?? null,
      })),
    [warmChats, taskTitles],
  );

  // The previous model, so the builders can hand back their own unchanged rows
  // rather than rebuilding every section whenever one of them moves. `useMemo`
  // alone cannot do this - it has no access to what it produced last time.
  //
  // Held in a module WeakMap keyed by a per-instance token, the same shape
  // `useStableChatTimelineRows` uses and for the same reason: reading a ref
  // during render is what `react-hooks/refs` forbids. The entry is published
  // from render, so a discarded render can advance it - which is harmless here
  // because the builders are idempotent (rebuilding from identical inputs
  // against a previous that already equals the result returns that same
  // result), and nothing downstream reasons about what was last COMMITTED.
  const [cacheKey] = useState<object>(() => ({}));
  const model = useMemo(() => {
    const previous = focusModelCache.get(cacheKey) ?? EMPTY_FOCUS_MODEL;
    const next = buildFocusModel(
      {
        notificationRows,
        tasks: {
          byEpic,
          taskTitles,
          mountedEpicIds: projection.mountedEpicIds,
          agentIdentities: projection.agentIdentities,
          indicatorEpics: indicators.epics,
          coldEpicHostIds,
          activeHostId,
          reachableHostIds,
        },
        backgroundChats,
        activity: {
          connectionStatus,
          cloudSyncStatus,
          stateFrameSeenThisEpoch,
          connectableHostCount: connectableHosts.hostIds.length,
          connectableHostsResolved: connectableHosts.resolved,
        },
        feedMode,
      },
      previous,
    );
    focusModelCache.set(cacheKey, next);
    return next;
  }, [
    cacheKey,
    notificationRows,
    byEpic,
    taskTitles,
    projection.mountedEpicIds,
    projection.agentIdentities,
    indicators.epics,
    backgroundChats,
    coldEpicHostIds,
    activeHostId,
    reachableHostIds,
    connectionStatus,
    cloudSyncStatus,
    stateFrameSeenThisEpoch,
    connectableHosts.hostIds.length,
    connectableHosts.resolved,
    feedMode,
  ]);
  return model;
}

function workingEpicIds(
  byEpic: ReadonlyMap<string, { readonly working: ReadonlySet<string> }>,
): ReadonlySet<string> {
  const epicIds = new Set<string>();
  for (const [epicId, activity] of byEpic) {
    if (activity.working.size > 0) epicIds.add(epicId);
  }
  return epicIds;
}

const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();
const EMPTY_IDS: ReadonlyArray<string> = [];
/**
 * THREE separators, one per nesting level, and they must stay distinct.
 *
 * An earlier version reused the id-list separator for the group list, so a
 * single epic with two working agents - a root plus one subagent, the most
 * ordinary state Home has - encoded to `epic<GROUP>a1<LIST>a2` and split back
 * into two GROUPS, leaving the second without an id list at all. Nesting one
 * delimited list inside another delimited list needs a delimiter the inner one
 * cannot contain, which is why the outer level gets its own code point and is
 * split first.
 */
const ID_LIST_SEPARATOR = "\u0000";
const ID_GROUP_SEPARATOR = "\u0001";
const ID_GROUP_LIST_SEPARATOR = "\u0002";

/** Byte-order ascending, so every derived id list is stable frame to frame and
 * the indicator slice always covers the same epics. Joined on a NUL, which no
 * id can carry. */
function joinIds(ids: ReadonlySet<string>): string {
  return Array.from(ids).sort(compareAscending).join(ID_LIST_SEPARATOR);
}

function splitIds(key: string): ReadonlyArray<string> {
  return key.length === 0 ? EMPTY_IDS : key.split(ID_LIST_SEPARATOR);
}

/** The sorted union of several joined keys. */
function unionIds(keys: ReadonlyArray<string>): ReadonlyArray<string> {
  const ids = new Set(keys.flatMap((key) => splitIds(key)));
  return ids.size === 0 ? EMPTY_IDS : Array.from(ids).sort(compareAscending);
}

/**
 * Inverse of the `agentRefsKey` encoding: one group per epic, each
 * `<epicId><GROUP><joined agent ids>`, groups separated by `<GROUP_LIST>`.
 *
 * Split on the OUTERMOST separator first, then cut each group at its first
 * group separator rather than destructuring the split - a group that somehow
 * carries no separator yields an epic with no agents instead of an exception
 * inside a `useMemo`, which React surfaces as the whole page failing.
 */
function decodeAgentRefs(key: string): ReadonlyArray<MountedEpicRef> {
  if (key.length === 0) return EMPTY_AGENT_REFS;
  return key.split(ID_GROUP_LIST_SEPARATOR).map((group) => {
    const separatorIndex = group.indexOf(ID_GROUP_SEPARATOR);
    if (separatorIndex < 0) return { epicId: group, agentIds: EMPTY_IDS };
    return {
      epicId: group.slice(0, separatorIndex),
      agentIds: splitIds(group.slice(separatorIndex + 1)),
    };
  });
}

const EMPTY_AGENT_REFS: ReadonlyArray<MountedEpicRef> = [];

/**
 * Cloud-index titles, displaced by the live projection's title wherever this
 * window has the epic open. An empty title is dropped rather than stored: the
 * cloud index keeps an epic's RAW title, and "" there means untitled, not
 * named "".
 */
function mergeTaskTitles(
  tasksById: ReadonlyMap<string, ListTaskLight>,
  liveTitles: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const titles = new Map<string, string>();
  for (const [epicId, task] of tasksById) {
    const title = task.epic?.light?.title ?? task.phase?.light?.title ?? "";
    if (title.length > 0) titles.set(epicId, title);
  }
  for (const [epicId, title] of liveTitles) titles.set(epicId, title);
  return titles;
}

/**
 * Epic id → the one host that owns this task's chats, and only when the cloud
 * index names EXACTLY one.
 *
 * `chatHostIds` is "the hosts owning the signed-in user's own live chats in
 * this task", and `undefined` (a peer too old to report it) is not `[]`. Two or
 * more hosts is unusable here: nothing in it says WHICH host a given agent id
 * belongs to, and a wrong guess aims a stop at a machine that never ran the
 * agent. One host is the case worth resolving - it is also the overwhelmingly
 * common one - and it is what lets a task nobody has opened in this window
 * still show as stoppable.
 */
function singleHostTaskIds(
  tasksById: ReadonlyMap<string, ListTaskLight>,
): ReadonlyMap<string, string> {
  const hostIds = new Map<string, string>();
  for (const [epicId, task] of tasksById) {
    const chatHostIds = task.chatHostIds ?? [];
    if (chatHostIds.length !== 1) continue;
    hostIds.set(epicId, chatHostIds[0]);
  }
  return hostIds;
}
