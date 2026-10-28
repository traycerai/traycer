import type {
  BotOpenPausedReason,
  BotOpenResponse,
} from "@traycer/protocol/host/bot/schemas";

/**
 * Why a bot tab shows the paused banner: one of `bot.open`'s paused
 * reasons. Paused says only that no host can run the bot's turns now; the
 * channel still renders, served by the tab's host (Tracy Bots T65).
 */
export type BotTabPausedReason = BotOpenPausedReason;

export interface BotPausedCopy {
  readonly text: string;
  /** Asking again can change the answer without anything else moving. */
  readonly retry: boolean;
}

/**
 * What the paused state says, per reason. No machine is named: the host a
 * bot runs on is not the person's concern (Tracy Bots, host-invisible
 * revision). "Delivered when it's back" is said only where a send really
 * waits for a host to return.
 */
export function botPausedCopy(
  reason: BotTabPausedReason,
  environmentLabel: string,
): BotPausedCopy {
  switch (reason) {
    case "host-not-in-environment":
      return {
        text: `Paused: the host this bot runs on is away, and this one doesn't run ${environmentLabel}'s bots. Messages you send are delivered when it's back.`,
        retry: false,
      };
    // Neither answer says the bot is stopped - a teammate's machine is outside
    // this reader's directory even while it runs - so the copy states only
    // what the reader gets here: the channel, and posts that reach the bot.
    case "bound-to-sandbox":
    case "bound-host-not-observable":
      return {
        text: "Couldn't check whether this bot is running. Messages you send still reach it.",
        retry: false,
      };
    case "reachability-unknown":
      return {
        text: "Couldn't check whether this bot is running.",
        retry: true,
      };
    case "trunk-busy":
      return {
        text: "Finishing an earlier turn here. Try again in a moment.",
        retry: true,
      };
  }
}

/**
 * Where the tab stands after `bot.open`, as the tab renders it:
 * - `opening`: no answer yet;
 * - `serving`: the tab's host serves the bot's channel - it runs the bot, or
 *   another host does and this one reads the channel from the cloud and the
 *   environment room (T65); the tab never moves to the bot's host;
 * - `paused`: no host can run the bot's turns now; the reason picks the
 *   banner's copy, and the channel still renders;
 * - `failed`: the open itself failed.
 */
export type BotTabOpenState =
  | { readonly kind: "opening" }
  | { readonly kind: "serving" }
  | { readonly kind: "paused"; readonly reason: BotTabPausedReason }
  | { readonly kind: "failed"; readonly message: string };

/** Reads `bot.open`'s answer for the tab. */
export function botTabOpenState(input: {
  readonly response: BotOpenResponse | undefined;
  readonly error: string | null;
}): BotTabOpenState {
  const { response, error } = input;
  if (error !== null) return { kind: "failed", message: error };
  if (response === undefined) return { kind: "opening" };
  const { outcome } = response;
  switch (outcome.kind) {
    case "serve-here":
    case "serve-on-bound-host":
      return { kind: "serving" };
    case "paused":
      return { kind: "paused", reason: outcome.reason };
  }
}
