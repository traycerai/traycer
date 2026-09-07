import { type ReactNode } from "react";
import { create } from "zustand";

/**
 * Registry of surface-contributed actions for the right of the mobile header. Desktop never
 * renders the mobile header, so this is unused there.
 */
interface MobileHeaderState {
  readonly rightActionEntries: ReadonlyMap<string, ReactNode>;
  readonly registerRightActions: (key: string, node: ReactNode) => void;
  readonly unregisterRightActions: (key: string) => void;
}

/** Key for the landing terminal toggle as hosted by one start page. */
export function landingTerminalRightActionsKey(landingPageId: string): string {
  return `landing-terminal:${landingPageId}`;
}

/** Key for an epic tab's header actions (the tab switcher trigger). */
export function epicTabRightActionsKey(tabId: string): string {
  return `epic-tab:${tabId}`;
}

export const useMobileHeaderStore = create<MobileHeaderState>((set) => ({
  rightActionEntries: new Map<string, ReactNode>(),
  registerRightActions: (key, node) => {
    set((state) => {
      const next = new Map(state.rightActionEntries);
      next.set(key, node);
      return { rightActionEntries: next };
    });
  },
  unregisterRightActions: (key) => {
    set((state) => {
      if (!state.rightActionEntries.has(key)) return state;
      const next = new Map(state.rightActionEntries);
      next.delete(key);
      return { rightActionEntries: next };
    });
  },
}));
