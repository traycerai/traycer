import type {
  BotOpenPausedReason,
  BotOpenResponse,
} from "@traycer/protocol/host/bot/schemas";
import type { ConnectableHosts } from "@/hooks/host/use-connectable-host-ids";

/**
 * Why a bot tab shows the paused state instead of the bot's live
 * conversation: one of `bot.open`'s paused reasons (T18), or
 * `bound-host-not-dialable` - another host serves the bot, but this client
 * holds no route to it (a team machine another member added), so the tab
 * stays on the opening host.
 */
export type BotTabPausedReason =
  | BotOpenPausedReason
  | "bound-host-not-dialable";

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
        text: `Paused: the machine this bot runs on is away, and this one doesn't run ${environmentLabel}'s bots. Messages you send are delivered when it's back.`,
        retry: false,
      };
    case "bound-to-sandbox":
      return {
        text: `Paused: ${environmentLabel}'s machine for this bot can't be reached right now. Messages you send are delivered when it's back.`,
        retry: false,
      };
    case "bound-host-not-observable":
      return {
        text: "Paused while the teammate's machine it runs on is away. Messages you send are delivered when it's back.",
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
    case "bound-host-not-dialable":
      return {
        text: `Running on ${environmentLabel}'s machine, which this app can't connect to from here yet. Messages you send are delivered.`,
        retry: false,
      };
  }
}

/**
 * Where the tab stands after `bot.open`, as the tab renders it:
 * - `opening`: no answer yet, or the tab is about to move to the host that
 *   serves the bot;
 * - `serving`: this tab's host runs the bot;
 * - `paused`: no host can serve the bot to this tab now; the reason picks
 *   the copy;
 * - `failed`: the open itself failed.
 */
export type BotTabOpenState =
  | { readonly kind: "opening" }
  | { readonly kind: "serving" }
  | { readonly kind: "paused"; readonly reason: BotTabPausedReason }
  | { readonly kind: "failed"; readonly message: string };

/**
 * Reads `bot.open`'s answer for the tab on `tabHostId`. Another host serving
 * the bot is a move when this client can dial that host (the caller rebinds
 * the tab, and the new host answers `serve-here`), and the paused state when
 * it cannot: the bot is running, just not anywhere this app reaches.
 */
export function botTabOpenState(input: {
  readonly response: BotOpenResponse | undefined;
  readonly error: string | null;
  readonly tabHostId: string;
  readonly connectable: ConnectableHosts;
}): BotTabOpenState {
  const { response, error, tabHostId, connectable } = input;
  if (error !== null) return { kind: "failed", message: error };
  if (response === undefined) return { kind: "opening" };
  const { outcome } = response;
  switch (outcome.kind) {
    case "serve-here":
      return { kind: "serving" };
    case "paused":
      return { kind: "paused", reason: outcome.reason };
    case "serve-on-bound-host":
      if (outcome.hostId === tabHostId) return { kind: "serving" };
      if (!connectable.resolved) return { kind: "opening" };
      return connectable.hostIds.includes(outcome.hostId)
        ? { kind: "opening" }
        : { kind: "paused", reason: "bound-host-not-dialable" };
  }
}

/**
 * The host to move the tab to after `bot.open`, or `null` to stay: another
 * host serves the bot and this client is KNOWN to dial it. Until the
 * directory answers, `opening` also covers "not known yet", and a move made
 * then would strand the tab on a host it may never reach.
 */
export function botTabMoveTarget(input: {
  readonly response: BotOpenResponse | undefined;
  readonly tabHostId: string;
  readonly connectable: ConnectableHosts;
}): string | null {
  const { response, tabHostId, connectable } = input;
  if (response === undefined) return null;
  const { outcome } = response;
  if (outcome.kind !== "serve-on-bound-host") return null;
  if (outcome.hostId === tabHostId || !connectable.resolved) return null;
  return connectable.hostIds.includes(outcome.hostId) ? outcome.hostId : null;
}
