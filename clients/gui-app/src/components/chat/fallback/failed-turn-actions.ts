import { useLayoutEffect, useState } from "react";
import { create, useStore } from "zustand";
import type {
  ChatRunSettings,
  LastFailedAttempt,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { RefusalNoteCopy } from "./fallback-copy";

/**
 * Which of its actions the failed-turn card draws, and the one record of what
 * a refusal took away - read by the card (`fallback-manual-rungs.tsx`) and by
 * the composer's banner predicate (`use-settled-routing-card-offers-switch.ts`).
 *
 * The refusal used to be the card's local state, which the banner could not
 * see: a bare Retry refused as `message_changed` removed every button on the
 * card, `lastFailedAttempt` stayed as it was, and the banner - held back
 * because the card "offered" a switch - never returned (review F4, 2026-09-27).
 * Two copies of the rule would disagree on exactly that frame, so there is one,
 * here, and both read it.
 *
 * In its own module rather than beside the card for the reason
 * `fallback-return-low-usage.ts` gives: a `.tsx` exporting non-components
 * breaks fast refresh.
 */

export type ManualAction = "retry" | "switch" | "wait";

/**
 * The card's last refusal, and the attempt it answered: a refusal is about
 * one attempt, so it reads as nothing once the host names another.
 */
export interface FailedTurnRefusal {
  readonly turnId: string;
  readonly copy: RefusalNoteCopy;
}

/**
 * One entry per chat, in memory only, written by the card's bare Retry and
 * Wait answers (the picker's Switch answers in its own footer and withdraws
 * nothing here) and cleared by the next press.
 *
 * ## Whose it is
 *
 * The CARDS', jointly: the same chat can be open in several tiles, and each
 * draws its own card for the same attempt from this one entry. So the entry
 * lives exactly as long as SOME card of its turn is mounted - each card holds
 * it ({@link useHoldFailedTurnRefusal}), and only the last to leave takes it
 * along (review F7, 2026-09-27). One card's leaving must not hand the others
 * back the buttons the host refused; and the last card's leaving must, so a
 * returning attempt never reappears under a stale refusal - which the card's
 * local state used to guarantee by being destroyed with it.
 *
 * Held per card INSTANCE, never per chat, for the reason `chat-tile.tsx` gives
 * its inline-edit image holder: a chat-keyed hold is one slot that every tile
 * of the chat shares, and the first tile to close releases it for all of them.
 */
const failedTurnRefusals = create<{
  readonly byChat: ReadonlyMap<string, FailedTurnRefusal>;
}>()(() => ({ byChat: new Map() }));

/**
 * The mounted cards, per chat: each card's own token and the turn it holds.
 * Not reactive - nothing renders from it; it decides only who may write and
 * when the entry goes.
 */
const holdersByChat = new Map<string, Map<object, string>>();

/** The chat a refusal belongs to: the card's and the composer's shared key. */
export interface FailedTurnChat {
  readonly hostId: string;
  readonly chatId: string;
}

function chatKey(chat: FailedTurnChat): string {
  return JSON.stringify([chat.hostId, chat.chatId]);
}

/** This chat's recorded refusal, whichever attempt it answered. */
export function useFailedTurnRefusal(
  chat: FailedTurnChat,
): FailedTurnRefusal | null {
  const key = chatKey(chat);
  return useStore(failedTurnRefusals, (state) => state.byChat.get(key) ?? null);
}

function turnIsHeld(key: string, turnId: string): boolean {
  const holders = holdersByChat.get(key);
  if (holders === undefined) return false;
  for (const heldTurnId of holders.values()) {
    if (heldTurnId === turnId) return true;
  }
  return false;
}

function writeRefusal(
  key: string,
  turnId: string,
  copy: RefusalNoteCopy | null,
): void {
  failedTurnRefusals.setState((state) => {
    const byChat = new Map(state.byChat);
    if (copy === null) {
      byChat.delete(key);
    } else {
      byChat.set(key, { turnId, copy });
    }
    return { byChat };
  });
}

/**
 * Records the refusal `turnId`'s attempt got, or clears it (`null`) - but
 * only while a card of that turn is mounted to show it. Answers whether it
 * did: `false` means no card is left to say it, and the caller speaks it
 * through the chat's announcer instead.
 */
export function recordFailedTurnRefusal(
  chat: FailedTurnChat,
  turnId: string,
  copy: RefusalNoteCopy | null,
): boolean {
  const key = chatKey(chat);
  if (!turnIsHeld(key, turnId)) return false;
  writeRefusal(key, turnId, copy);
  return true;
}

/**
 * Holds this chat's refusal for `turnId` while the calling card is mounted,
 * and drops it when the LAST card of that turn leaves - never a newer turn's.
 *
 * A LAYOUT effect, for the reason `useFallbackOutcomeReporting` gives: an
 * answer is a microtask, and one landing between the commit that removed the
 * last card and a passive cleanup would be recorded into a card that is gone
 * and then dropped, spoken nowhere.
 */
export function useHoldFailedTurnRefusal(
  chat: FailedTurnChat,
  turnId: string,
): void {
  // An identity per card instance - a fresh object, so two tiles never share
  // a token, whichever React root each renders in.
  const [holder] = useState(() => ({}));
  const key = chatKey(chat);
  useLayoutEffect(() => {
    let holders = holdersByChat.get(key);
    if (holders === undefined) {
      holders = new Map();
      holdersByChat.set(key, holders);
    }
    holders.set(holder, turnId);
    return () => {
      const current = holdersByChat.get(key);
      if (current === undefined) return;
      current.delete(holder);
      if (current.size === 0) holdersByChat.delete(key);
      if (turnIsHeld(key, turnId)) return;
      if (failedTurnRefusals.getState().byChat.get(key)?.turnId !== turnId) {
        return;
      }
      writeRefusal(key, turnId, null);
    };
  }, [holder, key, turnId]);
}

/** The refusal that answered THIS attempt, or `null`. */
export function refusalForAttempt(
  refusal: FailedTurnRefusal | null,
  attempt: LastFailedAttempt,
): RefusalNoteCopy | null {
  return refusal !== null && refusal.turnId === attempt.turnId
    ? refusal.copy
    : null;
}

/**
 * Which actions a refusal leaves standing (the spec's "Buttons left" column).
 * No refusal yet leaves all of them.
 */
export function refusalLeaves(
  refusal: RefusalNoteCopy | null,
): Readonly<Record<ManualAction, boolean>> {
  const remaining = refusal === null ? "all" : refusal.remaining;
  switch (remaining) {
    case "all":
      return { retry: true, switch: true, wait: true };
    case "retry_and_switch":
      return { retry: true, switch: true, wait: false };
    case "switch":
      return { retry: false, switch: true, wait: false };
    case "none":
      return { retry: false, switch: false, wait: false };
  }
}

/**
 * What the chooser seeds from: the failed tuple, else the chat's own
 * persisted settings. `null` when neither exists - there is then nothing to
 * stage a switch FROM, and the switch is not offered.
 */
export function failedTurnSwitchSeed(
  attempt: LastFailedAttempt,
  chatSettings: ChatRunSettings | null,
): ChatRunSettings | null {
  return attempt.failedTuple ?? chatSettings;
}

/**
 * Whether the card draws "Switch to…" for this attempt: the host admitted it,
 * there is a tuple to switch from, and no refusal took it away. Drawn
 * DISABLED while a press is in flight or the stream reconnects - drawn all the
 * same, and those states end in a new attempt or a refusal, both read here.
 */
export function failedTurnSwitchOffered(input: {
  readonly attempt: LastFailedAttempt;
  readonly refusal: RefusalNoteCopy | null;
  readonly seedTuple: ChatRunSettings | null;
}): boolean {
  return (
    input.attempt.eligibleRungs.includes("switch") &&
    input.seedTuple !== null &&
    refusalLeaves(input.refusal).switch
  );
}
