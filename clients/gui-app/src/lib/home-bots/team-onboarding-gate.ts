import type { BotOnboardingReadResponse } from "@traycer/protocol/host/bot/onboarding-schemas";

/**
 * Where a team environment stands with its onboarding (Tracy Bots T48,
 * decision 11), the one predicate every way into the team's chat reads: the
 * onboarding card, "Add a bot" in the channel sidebar and on Home, and the
 * sidebar's channel rows.
 *
 * - `none`: no onboarding applies. A personal environment; a host that does
 *   not serve `bot.onboarding.read`; an onboarding that completed; a read
 *   that failed (a failing read never locks the team out); and a team that
 *   has bots and no onboarding record, which pre-dates onboarding: its bots
 *   were made one by one, and it is never asked to onboard.
 * - `open`: the onboarding applies and the team's GitHub set holds a
 *   repository, so its chat is open while the card finishes.
 * - `locked`: the onboarding applies and the set holds no repository yet, or
 *   the read has not answered for a team with no bots: no bot is added and
 *   no channel is entered until it does.
 * - `pending`: the read has not answered for a team that has bots, which
 *   may be locked or may pre-date onboarding. Where a channel would open
 *   now, it waits for the answer; elsewhere it reads as not locked.
 *
 * A team is told apart from one that pre-dates onboarding by its record: the
 * first tick of a box keeps one, and a new team has no bots without one.
 */
export type TeamOnboardingGate = "none" | "open" | "locked" | "pending";

export function teamOnboardingGate(input: {
  readonly isTeam: boolean;
  readonly supported: boolean;
  readonly read: {
    readonly status: "pending" | "error" | "success";
    readonly data: BotOnboardingReadResponse | undefined;
  };
  /** The environment's bots as its list shows them now. */
  readonly botCount: number;
}): TeamOnboardingGate {
  const { isTeam, supported, read, botCount } = input;
  if (!isTeam || !supported || read.status === "error") return "none";
  const data = read.data;
  if (data === undefined) return botCount === 0 ? "locked" : "pending";
  const choice = data.choice;
  if (choice !== null && choice.completedAt !== null) return "none";
  if (choice === null && botCount > 0) return "none";
  return data.unlocked ? "open" : "locked";
}
