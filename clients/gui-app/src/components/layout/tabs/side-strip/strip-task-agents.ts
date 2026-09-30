import { useContext, useMemo } from "react";
import {
  ownChatStatusKind,
  type ChatDescendantStatusKind,
} from "@/components/epic-canvas/sidebar/use-chat-archive-hidden-ids";
import { NotificationIndicatorsContext } from "@/components/notifications/notification-indicator-context";
import { agentActivityTiers } from "@/lib/agent-activity";
import {
  useRegisteredEpicAgentUpdatedAts,
  useRegisteredEpicLiveAgentIds,
  useRegisteredEpicLiveAgents,
} from "@/lib/epic-selectors";
import { useEpicAgentActivity } from "@/stores/agent-activity-store";
import { useAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";
import { selectNotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";

/** What a nested agent row says, in the order the strip lists them. */
export type StripAgentStatus = "waiting" | "failed" | "turn" | "background";

/** One live agent of a task, as the strip nests it under the task's row. */
export interface StripAgent {
  readonly id: string;
  /** `null` while the agent is untitled. */
  readonly title: string | null;
  readonly status: StripAgentStatus;
  /** The Agents panel's ladder kind behind `status`, which picks the row's glyph. */
  readonly kind: ChatDescendantStatusKind;
  /**
   * The node's `updatedAt`, so for a running agent the time of its last
   * update, not of its turn's start: the session projection carries no time
   * for when the agent entered its current state.
   */
  readonly since: number;
}

export interface StripTaskAgents {
  /**
   * Whether this window holds a session for the task, the only thing that
   * names its agents. A cold task has `agents` empty and is not expandable.
   */
  readonly warm: boolean;
  /** The task's live agents in list order; empty for a cold task. */
  readonly agents: ReadonlyArray<StripAgent>;
}

const STATUS_RANK: Readonly<Record<StripAgentStatus, number>> = {
  waiting: 0,
  failed: 1,
  turn: 2,
  background: 3,
};

/**
 * The strip's agent order: needs you, then failed, then running, then
 * background. Within a status the latest comes first, so running agents lead
 * with the latest turn; the id settles ties so the order never flickers.
 */
function orderStripAgents(
  agents: ReadonlyArray<StripAgent>,
): ReadonlyArray<StripAgent> {
  return [...agents].sort(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      b.since - a.since ||
      a.id.localeCompare(b.id),
  );
}

/**
 * The agents the strip lists: running, background, waiting for you and
 * unread-failed. An agent that is only done, or whose host the activity plane
 * does not reach, is not one of them.
 */
const STATUS_OF_KIND: Readonly<
  Record<ChatDescendantStatusKind, StripAgentStatus | null>
> = {
  approval: "waiting",
  interview: "waiting",
  fork: "waiting",
  failure: "failed",
  running: "turn",
  background: "background",
  done: null,
  "terminal-failure": null,
};

/**
 * What the strip nests under one task's row, for any task; a tab that is not
 * a task (`null`) has none.
 *
 * Names come from the task's open-epic session, which only a warm task has;
 * the busy tiers come from the activity plane and each agent's waiting or
 * failed state from the strip's notification indicators, which already cover
 * every warm tab's chats. Read it under `TabStripIndicatorScope`.
 */
export function useStripTaskAgents(epicId: string | null): StripTaskAgents {
  const liveAgentIds = useRegisteredEpicLiveAgentIds(epicId);
  const tiers = agentActivityTiers(useEpicAgentActivity(epicId));
  const indicators = useContext(NotificationIndicatorsContext);
  const localRows = useAppLocalNotificationsStore((state) => state.byId);
  const statuses = useMemo(() => {
    const found: Array<{
      readonly id: string;
      readonly status: StripAgentStatus;
      readonly kind: ChatDescendantStatusKind;
    }> = [];
    if (epicId === null || liveAgentIds === null) return found;
    for (const id of liveAgentIds) {
      const kind = ownChatStatusKind(
        selectNotificationIndicatorState(
          { byId: localRows },
          { epicId, chatId: id },
          null,
          indicators,
        ),
        tiers.get(id),
        "indeterminate",
      );
      // "unknown" is an agent nothing says is live, which the strip skips.
      if (kind === null || kind === "unknown") continue;
      const status = STATUS_OF_KIND[kind];
      if (status !== null) found.push({ id, status, kind });
    }
    return found;
  }, [epicId, liveAgentIds, tiers, indicators, localRows]);
  const listedIds = useMemo(() => statuses.map(({ id }) => id), [statuses]);
  const refs = useMemo(
    () =>
      epicId === null ? [] : listedIds.map((agentId) => ({ epicId, agentId })),
    [epicId, listedIds],
  );
  const named = useRegisteredEpicLiveAgents(refs);
  const updatedAts = useRegisteredEpicAgentUpdatedAts(epicId, listedIds);
  const agents = useMemo(
    () =>
      orderStripAgents(
        statuses.flatMap(({ id, status, kind }, index) => {
          const agent = named[index] ?? null;
          return agent === null
            ? []
            : [
                {
                  id,
                  title: agent.title,
                  status,
                  kind,
                  since: updatedAts.at(index) ?? 0,
                },
              ];
        }),
      ),
    [statuses, named, updatedAts],
  );
  const warm = liveAgentIds !== null;
  return useMemo(() => ({ warm, agents }), [warm, agents]);
}
