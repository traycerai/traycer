import type { TeamSetup } from "@/hooks/bots/use-team-setups";

/** What a bot's tab shows: its channel, a team's setup, or neither yet. */
export type BotTabRouteView =
  | { readonly kind: "connecting" }
  | { readonly kind: "setup"; readonly setup: TeamSetup }
  | { readonly kind: "unresolved" }
  | { readonly kind: "bot" };

/**
 * What a bot's tab shows (`BotTabRoute`). A bot the tab has seen listed is
 * that bot: its channel opens, and closes once a list without it answers.
 * Any other bot may be a team's main bot still to be set up, so it is shown
 * as a bot only on what both lists answered: a list that never answered, or
 * whose last read failed, says nothing about what is absent, and leaves the
 * tab `unresolved` until it is read again; a bot the answered lists do not
 * carry is opened only once they are fresh and every team's setup is known.
 */
export function botTabRouteOf(input: {
  /** Either list has not answered and is still being read. */
  readonly listsPending: boolean;
  /** The bot is listed now, or this tab has shown it listed. */
  readonly seenListed: boolean;
  /** Both lists hold an answer. */
  readonly listsAnswered: boolean;
  /** The bot list's last read failed. */
  readonly listFailed: boolean;
  /** The team setup whose bot this is; `null` for none. */
  readonly setup: TeamSetup | null;
  /** The bot list is older than the tab or than the newest setup read. */
  readonly listStale: boolean;
  readonly setupsSettled: boolean;
  readonly setupsUnresolved: boolean;
}): BotTabRouteView {
  if (input.listsPending) return { kind: "connecting" };
  if (input.seenListed) return { kind: "bot" };
  if (!input.listsAnswered) return { kind: "unresolved" };
  if (input.setup !== null) return { kind: "setup", setup: input.setup };
  if (input.listFailed) return { kind: "unresolved" };
  if (input.listStale || !input.setupsSettled) return { kind: "connecting" };
  return input.setupsUnresolved ? { kind: "unresolved" } : { kind: "bot" };
}
