/**
 * Which of the office's two person-facing flags an agent raises: a crashed
 * screen, or a "!" bubble asking for someone.
 *
 * The failure test is `attentionTone`'s OWN first branch, restated rather than
 * re-invented - an unread NON-terminal failure. A terminal agent's failure is
 * deliberately not one: it is history the feed still carries, and a newer
 * running turn is allowed to own the desk. Everything else `attentionTone`
 * accepts (fork, interview, approval) is a person being waited on.
 *
 * Callers ask `attentionTone` whether there is a flag AT ALL and then ask this
 * which one it is, so the two can never disagree about a single agent.
 */
import type { NotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";

export type OfficeFlagKind = "failure" | "attention";

export function officeFlagKind(
  state: NotificationIndicatorState,
): OfficeFlagKind {
  const unreadNonTerminalFailure =
    state.unreadNonTerminalFailure ??
    (state.unreadFailure && state.unreadTerminalFailure !== true);
  return unreadNonTerminalFailure ? "failure" : "attention";
}
