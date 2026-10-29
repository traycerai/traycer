import { create } from "zustand";
import type { BotSurfaceActionRefusalCode } from "@traycer/protocol/host/bot/schemas";
import type { BotSurfaceAction } from "@traycer/protocol/host/bot/surface-schemas";

/**
 * The person's own answer or decision from a bot's surface card (Tracy Bots
 * T89), as this window last heard of it: `sending` while the tab's host has
 * not answered; `forwarded` once it sent it on to the task's machine, until
 * the post shows the resolution; `settled` when the tab's host recorded it,
 * shown at once until the post's resolution lands; `refused` with why.
 * `actionId` is minted once per action and reused when the same action is
 * sent again, so the host takes a resend as the same action.
 */
export interface BotSurfaceActionEntry {
  readonly actionId: string;
  readonly action: BotSurfaceAction;
  readonly phase: "sending" | "forwarded" | "settled" | "refused";
  /** Why it was refused; `null` in every other phase. */
  readonly code: BotSurfaceActionRefusalCode | null;
}

type ByBot = Readonly<
  Partial<
    Record<string, Readonly<Partial<Record<string, BotSurfaceActionEntry>>>>
  >
>;

interface BotSurfaceActionsState {
  /** By bot, then by the post's message id. */
  readonly entries: ByBot;
  readonly setEntry: (
    botId: string,
    messageId: string,
    entry: BotSurfaceActionEntry | null,
  ) => void;
  readonly forgetBot: (botId: string) => void;
}

/**
 * Not persisted, and dropped when the bot's tab closes, as the card drafts
 * are (`bot-drafts-store.ts`): an action in flight outlives the Messages ↔
 * Activity switch and a thread closing, and the post's resolution is what
 * outlives the window.
 */
export const useBotSurfaceActionsStore = create<BotSurfaceActionsState>()(
  (set) => ({
    entries: {},
    setEntry: (botId, messageId, entry) =>
      set((state) => {
        const forBot = { ...state.entries[botId] };
        if (entry === null) delete forBot[messageId];
        else forBot[messageId] = entry;
        const next = { ...state.entries };
        if (Object.keys(forBot).length === 0) delete next[botId];
        else next[botId] = forBot;
        return { entries: next };
      }),
    forgetBot: (botId) =>
      set((state) => {
        if (state.entries[botId] === undefined) return state;
        const next = { ...state.entries };
        delete next[botId];
        return { entries: next };
      }),
  }),
);
