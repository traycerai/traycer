/**
 * What the suites of the Activity page's rows, badges and actions share.
 */
import { within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BotInputNeeded } from "@traycer/protocol/host/bot/schemas";
import {
  chatDescendantKind,
  chatDescendantStatusRollup,
} from "@/components/epic-canvas/sidebar/use-chat-archive-hidden-ids";
import type { AgentActivityTier } from "@/lib/agent-activity";
import {
  EMPTY_NOTIFICATION_INDICATOR_STATE,
  type NotificationIndicatorState,
} from "@/stores/notifications/notification-indicator-state";
import { mocks } from "@/components/bots/__tests__/bot-activity-page-mocks";
import { row } from "@/components/bots/__tests__/bot-activity-page-support";

const NONE_STATE: NotificationIndicatorState =
  EMPTY_NOTIFICATION_INDICATOR_STATE;

/** An approval of `agentChatId` waiting on a person, reported at `reportedAt`. */
export function waiting(
  agentChatId: string,
  reportedAt: number,
  summary: string,
): BotInputNeeded {
  return {
    hostId: "host-agents",
    hostName: "Studio Mac",
    agentChatId,
    surfaceId: `surface-${agentChatId}`,
    surface: {
      kind: "approval",
      approvalId: `approval-${agentChatId}`,
      tool: "gh pr merge",
      summary,
      tier: null,
      requiresPerson: true,
      askedAt: reportedAt,
    },
    reportedAt,
    acceptsActions: true,
  };
}

/** Unread done or failure, as the host's indicator read holds it per task. */
export function taskUnread(
  taskId: string,
  flags: Partial<NotificationIndicatorState>,
): void {
  mocks.state.epicFlags[taskId] = { ...flags, unreadCount: 1 };
}

/** What one agent chat holds, as the host's indicator read answers for it. */
export function agentUnread(
  chatId: string,
  flags: Partial<NotificationIndicatorState>,
): void {
  mocks.state.chatFlags[chatId] = { ...flags, unreadCount: 1 };
}

export function glyphKind(taskId: string): string | null {
  return within(row(taskId))
    .getByTestId("bot-activity-task-glyph")
    .getAttribute("data-kind");
}

/** What the Chats panel's own fold says for agents in these states. */
export function sidebarRollupKind(
  agents: ReadonlyArray<{
    readonly state: Partial<NotificationIndicatorState>;
    readonly tier: AgentActivityTier | undefined;
  }>,
): string {
  const rollup = chatDescendantStatusRollup(
    agents.map((agent) =>
      chatDescendantKind({ ...NONE_STATE, ...agent.state }, agent.tier),
    ),
  );
  return rollup?.kind ?? "none";
}

export async function expandRow(taskId: string): Promise<void> {
  await userEvent
    .setup()
    .click(within(row(taskId)).getByRole("button", { name: "Show agents" }));
}
