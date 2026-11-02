import { create } from "zustand";
import type { SlackAppView } from "@traycer/protocol/host/slack-app";

/**
 * A Slack install the person started and has not finished, per bot, so the
 * bot's settings keep watching its app across navigation (the pattern of
 * `model-provider-pending-auth-store.ts`). Slack's consent page sends no
 * signal back to the app, so the only way to learn the install landed is to
 * read the app again until it shows.
 *
 * Keyed by bot alone: the calls go to traycer-server with the person's
 * bearer, not through a host. The consent URL is not kept: it carries the
 * install's single-use state.
 */
export interface BotSlackPendingInstall {
  readonly botId: string;
  /** When the install URL stops working (epoch ms, the server's). */
  readonly expiresAt: number;
  /**
   * The app's `installedAt` when the URL was minted. An "Install again" on an
   * installed app starts from `installed`, so only a different `installedAt`
   * says this install landed.
   */
  readonly baselineInstalledAt: number | null;
}

interface BotSlackPendingInstallStore {
  readonly entries: Readonly<Record<string, BotSlackPendingInstall>>;
  /** A new install URL replaces the bot's pending one: minting retires the old. */
  readonly begin: (entry: BotSlackPendingInstall) => void;
  /** A new registration or a disconnect ends the wait outright. */
  readonly clear: (botId: string) => void;
  /**
   * Ends the wait when the app read says it is over: no app any more, the
   * install landed, or the URL expired. Kept otherwise, an `uninstalled` app
   * included, since the person can still finish the consent.
   */
  readonly settle: (
    botId: string,
    app: SlackAppView | null,
    now: number,
  ) => void;
  /**
   * The URL's time ran out: ends the wait it belonged to, and not one a
   * newer URL started since.
   */
  readonly expire: (botId: string, expiresAt: number) => void;
}

function without(
  entries: Readonly<Record<string, BotSlackPendingInstall>>,
  botId: string,
): Record<string, BotSlackPendingInstall> {
  const next = { ...entries };
  delete next[botId];
  return next;
}

function installOver(
  entry: BotSlackPendingInstall,
  app: SlackAppView | null,
  now: number,
): boolean {
  if (app === null || now >= entry.expiresAt) return true;
  return (
    app.installState === "installed" &&
    app.installedAt !== entry.baselineInstalledAt
  );
}

export const useBotSlackPendingInstallStore =
  create<BotSlackPendingInstallStore>()((set) => ({
    entries: {},
    begin: (entry) =>
      set((state) => ({ entries: { ...state.entries, [entry.botId]: entry } })),
    clear: (botId) =>
      set((state) => {
        if (!Object.hasOwn(state.entries, botId)) return state;
        return { entries: without(state.entries, botId) };
      }),
    settle: (botId, app, now) =>
      set((state) => {
        if (!Object.hasOwn(state.entries, botId)) return state;
        if (!installOver(state.entries[botId], app, now)) return state;
        return { entries: without(state.entries, botId) };
      }),
    expire: (botId, expiresAt) =>
      set((state) => {
        if (!Object.hasOwn(state.entries, botId)) return state;
        if (state.entries[botId].expiresAt !== expiresAt) return state;
        return { entries: without(state.entries, botId) };
      }),
  }));
