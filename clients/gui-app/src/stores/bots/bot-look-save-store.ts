import { create } from "zustand";
import type { BotUpdateAppearanceRequest } from "@traycer/protocol/host/bot/schemas";

/** The parts of a bot's look one choice names; a part left out is kept. */
export type BotLookChange = Omit<BotUpdateAppearanceRequest, "botId">;

export type BotLookPart = keyof BotLookChange;

export const BOT_LOOK_PARTS: readonly BotLookPart[] = [
  "mark",
  "color",
  "eyewear",
  "accessory",
  "background",
];

/**
 * One bot's choices on their way to the cloud. Saves leave one at a time, in
 * the order chosen, because the cloud keeps whichever arrives last.
 */
export interface BotLookSave {
  /**
   * Every part chosen and not yet answered, at its latest choice: what the
   * bot's pictures draw over the look its list holds.
   */
  readonly chosen: BotLookChange;
  /** The parts in the save now with the host; `null` with none there. */
  readonly sending: BotLookChange | null;
  /** The parts chosen since that save left, which the next one carries. */
  readonly waiting: BotLookChange | null;
  /** Why each part's last save was refused, until that part is chosen again. */
  readonly refusals: Readonly<Partial<Record<BotLookPart, string>>>;
}

export const NO_BOT_LOOK_SAVE: BotLookSave = {
  chosen: {},
  sending: null,
  waiting: null,
  refusals: {},
};

interface BotLookSaveState {
  readonly saves: Readonly<Record<string, BotLookSave>>;
}

/** Each bot's unanswered choices, by bot id; a bot with none has no entry. */
export const useBotLookSaveStore = create<BotLookSaveState>(() => ({
  saves: {},
}));

export function botLookSaveOf(botId: string): BotLookSave {
  return useBotLookSaveStore.getState().saves[botId] ?? NO_BOT_LOOK_SAVE;
}

export function setBotLookSave(botId: string, save: BotLookSave): void {
  useBotLookSaveStore.setState((state) => ({
    saves: { ...state.saves, [botId]: save },
  }));
}

/** What `held` keeps once `parts` are taken out of it. */
export function withoutParts<
  Held extends Partial<Record<BotLookPart, unknown>>,
>(held: Held, parts: readonly BotLookPart[]): Held {
  const kept = { ...held };
  for (const part of parts) delete kept[part];
  return kept;
}

/** The parts `change` names. */
export function partsOf(change: BotLookChange | null): BotLookPart[] {
  if (change === null) return [];
  return BOT_LOOK_PARTS.filter((part) => change[part] !== undefined);
}
