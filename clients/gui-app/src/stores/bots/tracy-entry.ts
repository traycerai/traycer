import { useBotTabsStore } from "@/stores/bots/bot-tabs-store";
import { useTabsStore } from "@/stores/tabs/store";
import type { StripItem } from "@/stores/tabs/layout";
import {
  notifyTabStructuralLocksChanged,
  registerTabCloseLockPredicate,
  registerTabStructuralLockPredicate,
} from "@/stores/tabs/tab-structural-lock";
import type { TabRef } from "@/stores/tabs/types";

/**
 * The fixed Tracy entry (Tracy Bots T58): the personal main bot's tab, held
 * first in the strip and drawn beside Home rather than among the tabs. Its
 * bot is `fixedBotId` on the bot-tabs store; `TracyEntryController` sets it
 * from "Show Tracy" and the bot list.
 *
 * The entry's ref is locked for structure and close while it is the entry,
 * so no gesture moves, pairs, groups or closes it. Turning the setting off
 * clears `fixedBotId` first, which releases the lock, and then closes the tab.
 */
export function isTracyEntryRef(ref: TabRef): boolean {
  const fixedBotId = useBotTabsStore.getState().fixedBotId;
  return fixedBotId !== null && ref.kind === "bot" && ref.id === fixedBotId;
}

/** Whether a strip item is the entry's own (ungrouped) tab. */
export function isTracyEntryItem(
  item: StripItem,
  fixedBotId: string | null,
): boolean {
  return (
    fixedBotId !== null &&
    item.kind === "tab" &&
    item.ref.kind === "bot" &&
    item.ref.id === fixedBotId
  );
}

/** The strip item id of the entry's tab, or `null` with no entry drawn. */
export function useTracyEntryItemId(): string | null {
  const fixedBotId = useBotTabsStore((state) => state.fixedBotId);
  return useTabsStore(
    (state) =>
      state.items.find((item) => isTracyEntryItem(item, fixedBotId))?.id ??
      null,
  );
}

registerTabStructuralLockPredicate(isTracyEntryRef);
registerTabCloseLockPredicate(isTracyEntryRef);
useBotTabsStore.subscribe((next, previous) => {
  if (next.fixedBotId !== previous.fixedBotId) {
    notifyTabStructuralLocksChanged();
  }
});
