import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  liveAgentIdsSnapshot,
  useRegisteredEpicAgentActivityTiers,
  useRegisteredEpicLiveAgentIds,
  type AgentActivityTier,
} from "@/lib/epic-selectors";
import { getChatSessionRegistry } from "@/lib/registries/chat-session-registry";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import { reconcileStoreSubscriptions } from "@/lib/registries/reconcile-store-subscriptions";
import {
  type ChatSessionState,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import {
  chatActivityIndicator,
  type ChatActivityIndicator,
} from "@/components/epic-canvas/renderers/chat-tile-session-state";
import { approvalAwaitingJudge } from "@/components/epic-canvas/renderers/chat-approval-visibility";

const CHAT_REGISTRY = getChatSessionRegistry();
const EPIC_REGISTRY = getOpenEpicRegistry();

export type EpicActivityStatus = "idle" | "turn" | "background";

/**
 * Aggregates this epic's live chat sessions into the activity tier rendered
 * by task-level surfaces. A turn wins over background work across chats.
 *
 * Coverage is WARM-session-only for managed commands: a chat whose session
 * store is live contributes its shell-aware indicator, but an evicted or
 * never-opened chat falls back to the host-published activity tier, which
 * does not know shells exist. A running shell in a cold chat therefore shows
 * nothing here until the host's activity plane learns about managed commands
 * (a host-side follow-up, deliberately not faked client-side).
 */
export function useEpicActivityStatus(
  epicId: string | null,
): EpicActivityStatus {
  const activityTiers = useRegisteredEpicAgentActivityTiers(epicId);
  const liveAgentIds = useRegisteredEpicLiveAgentIds(epicId);
  const subscribeLocalChatActivity = useCallback(
    (onChange: () => void) =>
      subscribeLiveChatSessions(
        epicId,
        liveAgentIds,
        chatSessionActivity,
        onChange,
      ),
    [epicId, liveAgentIds],
  );
  const getLocalChatActivity = useCallback(
    () => epicActivityStatusFromSources(epicId, activityTiers, liveAgentIds),
    [activityTiers, epicId, liveAgentIds],
  );
  return useSyncExternalStore(
    subscribeLocalChatActivity,
    getLocalChatActivity,
    () => "idle" as const,
  );
}

/**
 * Reads session activity across a candidate set of chat ids, falling back to
 * the host-published activity tier for agents whose session state did not
 * resolve locally. `candidateIds` scopes the aggregation: the whole epic's
 * live agents for {@link useEpicActivityStatus}, or a node's descendant ids
 * for {@link useSubtreeChatActivityTier}.
 *
 * An open chat session is authoritative for its own tier ONLY when it reads
 * some activity - a local `"turn"`/`"background"` is never overridden by the
 * global source, so the two tiers can't be re-conflated. A session reading idle
 * is deliberately NOT treated as resolved: it still defers to presence, which
 * backfills the brief subscription-gap window where a genuinely running chat's
 * store has not received its first snapshot yet (same rule as the per-chat icon
 * in `chat-progress-icon.tsx`).
 *
 * Everything else - a chat that was never opened, or one whose warm session was
 * evicted - is resolved from `activityTiers`, which reports `"turn"` for any
 * host that does not classify its agents. That keeps the pre-existing
 * conservative reading intact against an unclassified host while letting a
 * classifying one report background-only work accurately.
 *
 * `candidateIds` is a LIVENESS filter over that fallback: an agent the epic's
 * projection no longer holds must not keep a spinner alive. `null` means this
 * window has NO session for the epic, so there is no projection to check
 * against and the filter is skipped entirely - that is the never-opened epic
 * the per-user activity room exists to cover, and filtering it against an
 * empty set would put the original defect straight back. An empty SET is a
 * different statement: a live projection that authoritatively holds no agents.
 */
export function epicActivityStatusFromSources(
  epicId: string | null,
  activityTiers: ReadonlyMap<string, AgentActivityTier>,
  candidateIds: ReadonlySet<string> | null,
): EpicActivityStatus {
  if (epicId === null) return "idle";
  let hasBackgroundActivity = false;
  const locallyResolvedAgentIds = new Set<string>();
  if (candidateIds !== null) {
    for (const handle of CHAT_REGISTRY.listHandles()) {
      if (handle.epicId !== epicId) continue;
      if (!candidateIds.has(handle.chatId)) continue;
      const activity = chatSessionActivity(handle.store.getState());
      if (activity === "turn") return "turn";
      if (activity === "background") {
        hasBackgroundActivity = true;
        locallyResolvedAgentIds.add(handle.chatId);
      }
    }
  }
  for (const [agentId, tier] of activityTiers) {
    if (candidateIds !== null && !candidateIds.has(agentId)) continue;
    if (locallyResolvedAgentIds.has(agentId)) continue;
    if (tier === "turn") return "turn";
    hasBackgroundActivity = true;
  }
  return hasBackgroundActivity ? "background" : "idle";
}

/**
 * Subscribes only to live chats in `candidateIds` belonging to this epic, and
 * calls `onChange` when `select` reads a different value from one of them or
 * the set of live chats changes.
 */
function subscribeLiveChatSessions<T>(
  epicId: string | null,
  candidateIds: ReadonlySet<string> | null,
  select: (state: ChatSessionState) => T,
  onChange: () => void,
): () => void {
  if (epicId === null || candidateIds === null || candidateIds.size === 0) {
    return noopUnsubscribe;
  }
  const handleSubs = new Map<ChatSessionStoreHandle, () => void>();

  const resync = (): void => {
    reconcileStoreSubscriptions(
      CHAT_REGISTRY.listHandles().filter(
        (handle) => handle.epicId === epicId && candidateIds.has(handle.chatId),
      ),
      handleSubs,
      (handle) => {
        let previous = select(handle.store.getState());
        return handle.store.subscribe((state) => {
          const next = select(state);
          if (Object.is(next, previous)) return;
          previous = next;
          onChange();
        });
      },
    );
    onChange();
  };

  const unsubscribeRegistry = CHAT_REGISTRY.subscribe(resync);
  resync();

  return () => {
    unsubscribeRegistry();
    for (const unsubscribe of handleSubs.values()) unsubscribe();
    handleSubs.clear();
  };
}

/** The row-level and list-level definition of activity for a warm chat. */
export function chatSessionActivity(
  state: ChatSessionState,
): ChatActivityIndicator {
  return chatActivityIndicator(state);
}

/** What a chat is blocked on the user for: a question to answer, or a gate to approve. */
export type EpicWaitingReason = "approval" | "reply";

/**
 * The warm session's own gate facts, which stay true while the agent is
 * blocked, including when no prompt notification is lit for it (cleared,
 * superseded, or not yet filed). A pending interview outranks an approval, the
 * order `attentionTone` uses. An approval under an auto-judge is not waiting on
 * the user until the judge escalates it; a plan approval is.
 */
export function chatSessionWaitingReason(
  state: ChatSessionState,
): EpicWaitingReason | null {
  if (state.pendingInterviews.length > 0) return "reply";
  if (
    state.pendingApprovals.some(
      (approval) => !approvalAwaitingJudge(approval),
    ) ||
    state.pendingFileEditApprovals.length > 0
  ) {
    return "approval";
  }
  return null;
}

/**
 * Aggregates {@link chatSessionWaitingReason} over the epic's live chats with
 * a warm session; `"reply"` outranks `"approval"`. `candidateIds` is the same
 * liveness filter {@link epicActivityStatusFromSources} takes, and `null` (no
 * session for the epic in this window) reads as not waiting, since only a warm
 * chat session knows it is blocked.
 *
 * Chats match by epic id only, not by host, the same scope
 * {@link epicActivityStatusFromSources} reads, so a tab bound to one host can
 * reflect a warm chat of the same epic id on another.
 */
export function epicWaitingReasonFromSessions(
  epicId: string | null,
  candidateIds: ReadonlySet<string> | null,
): EpicWaitingReason | null {
  if (epicId === null || candidateIds === null) return null;
  let reason: EpicWaitingReason | null = null;
  for (const handle of CHAT_REGISTRY.listHandles()) {
    if (handle.epicId !== epicId) continue;
    if (!candidateIds.has(handle.chatId)) continue;
    const chatReason = chatSessionWaitingReason(handle.store.getState());
    if (chatReason === "reply") return "reply";
    if (chatReason === "approval") reason = "approval";
  }
  return reason;
}

const NO_EPIC_IDS: ReadonlyArray<string> = [];
const NO_WAITING_REASONS: ReadonlyMap<string, EpicWaitingReason> = new Map();

/** Each epic of `epicIds` whose live chats are waiting on the user, and for what. */
function waitingReasonsOf(
  epicIds: ReadonlyArray<string>,
): ReadonlyMap<string, EpicWaitingReason> {
  const reasons = new Map<string, EpicWaitingReason>();
  for (const epicId of epicIds) {
    const reason = epicWaitingReasonFromSessions(
      epicId,
      liveAgentIdsSnapshot(EPIC_REGISTRY.peek(epicId)),
    );
    if (reason !== null) reasons.set(epicId, reason);
  }
  return reasons;
}

/**
 * Calls `onChange` when a live chat of one of `epicIds` starts or stops
 * waiting, when a chat session of theirs opens or closes, or when their live
 * chats change.
 */
function subscribeWaitingReasons(
  epicIds: ReadonlyArray<string>,
  onChange: () => void,
): () => void {
  if (epicIds.length === 0) return noopUnsubscribe;
  const wanted = new Set(epicIds);
  const chatSubscriptions = new Map<ChatSessionStoreHandle, () => void>();
  const epicSubscriptions = new Map<OpenEpicStoreHandle, () => void>();
  const resyncChats = (): void => {
    reconcileStoreSubscriptions(
      CHAT_REGISTRY.listHandles().filter((handle) => wanted.has(handle.epicId)),
      chatSubscriptions,
      (handle) =>
        handle.store.subscribe((state, previous) => {
          if (
            chatSessionWaitingReason(state) !==
            chatSessionWaitingReason(previous)
          ) {
            onChange();
          }
        }),
    );
    onChange();
  };
  const resyncEpics = (): void => {
    reconcileStoreSubscriptions(
      EPIC_REGISTRY.liveHandles().filter((handle) => wanted.has(handle.epicId)),
      epicSubscriptions,
      (handle) =>
        handle.store.subscribe((state, previous) => {
          if (
            state.chats.allIds !== previous.chats.allIds ||
            state.tuiAgents.allIds !== previous.tuiAgents.allIds
          ) {
            onChange();
          }
        }),
    );
    onChange();
  };
  const unsubscribeChatRegistry = CHAT_REGISTRY.subscribe(resyncChats);
  const unsubscribeEpicRegistry = EPIC_REGISTRY.subscribe(resyncEpics);
  resyncChats();
  resyncEpics();
  return () => {
    unsubscribeChatRegistry();
    unsubscribeEpicRegistry();
    for (const unsubscribe of chatSubscriptions.values()) unsubscribe();
    for (const unsubscribe of epicSubscriptions.values()) unsubscribe();
    chatSubscriptions.clear();
    epicSubscriptions.clear();
  };
}

/**
 * What each of `epicIds` has live chats waiting on the user for; an epic
 * that is not waiting is absent. The batched form of
 * {@link useEpicWaitingReason}, for a surface that reads many tasks, which
 * cannot call a hook per task. Pass a stable list.
 */
export function useEpicWaitingReasons(
  epicIds: ReadonlyArray<string>,
): ReadonlyMap<string, EpicWaitingReason> {
  const subscribe = useCallback(
    (onChange: () => void) => subscribeWaitingReasons(epicIds, onChange),
    [epicIds],
  );
  // A flat string, so `useSyncExternalStore`'s identity check is exact; the
  // map is read again from the same sessions whenever it changes.
  const getKey = useCallback(
    () =>
      [...waitingReasonsOf(epicIds)]
        .map(([epicId, reason]) => `${reason}:${epicId}`)
        .join("\n"),
    [epicIds],
  );
  const key = useSyncExternalStore(subscribe, getKey, () => "");
  return useMemo(
    () => (key === "" ? NO_WAITING_REASONS : waitingReasonsOf(epicIds)),
    [epicIds, key],
  );
}

/** What this epic's live chats are waiting on the user for, if anything. */
export function useEpicWaitingReason(
  epicId: string | null,
): EpicWaitingReason | null {
  const epicIds = useMemo(
    () => (epicId === null ? NO_EPIC_IDS : [epicId]),
    [epicId],
  );
  const reasons = useEpicWaitingReasons(epicIds);
  return epicId === null ? null : (reasons.get(epicId) ?? null);
}

function noopUnsubscribe(): void {}
