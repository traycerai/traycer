/**
 * Which of the office's two person-facing flags an agent raises: a crashed
 * screen, or a "!" bubble asking for someone.
 *
 * The failure test is `attentionTone`'s OWN first branch, shared rather than
 * restated - an unread NON-terminal failure. Everything else `attentionTone`
 * accepts (fork, interview, approval) is a person being waited on.
 *
 * Callers ask `attentionTone` whether there is a flag AT ALL and then ask this
 * which one it is, so the two can never disagree about a single agent.
 */
import { hasUnreadNonTerminalFailure } from "@/components/notifications/notification-indicator-tones";
import type { NotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";

export type OfficeFlagKind = "failure" | "attention";

export function officeFlagKind(
  state: NotificationIndicatorState,
): OfficeFlagKind {
  return hasUnreadNonTerminalFailure(state) ? "failure" : "attention";
}
