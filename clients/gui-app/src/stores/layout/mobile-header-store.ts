import { type ReactNode } from "react";
import { create } from "zustand";

/**
 * Registry of surface-contributed actions for the right of the mobile header.
 * Desktop never renders the mobile header, so this is unused there.
 *
 * Registration means AVAILABILITY, not presentation. A surface registers its
 * controls while it can serve them (its own mount lifecycle) and unregisters on
 * teardown; it never has to know whether it is the surface on screen. Which
 * entry the header actually shows is resolved from the presented surface at
 * read time (`useMobileHeaderRightActions`), so presentation changes need no
 * cooperation from any writer.
 *
 * That split is load-bearing. Surfaces here deliberately outlive their own
 * presentation - the landing terminal panel stays mounted behind an epic tab,
 * History or Settings to keep its PTYs warm - so "mounted" and "on screen" are
 * different facts, and they change in different commits. A single cell written
 * at those edges has to re-derive the level from them: every writer must gate
 * its publish on presentation, re-assert it when its surface is presented
 * again, and order its release against the next writer's claim. Each of those
 * obligations is a bug when one writer misses it. A registry keyed by surface
 * makes the writes commutative - registering and unregistering different keys
 * cannot race, a stale entry is simply never resolved - and the header's
 * output a pure function of layout state, correct in the same commit the
 * presented surface changes.
 */
interface MobileHeaderState {
  readonly rightActionEntries: ReadonlyMap<string, ReactNode>;
  readonly registerRightActions: (key: string, node: ReactNode) => void;
  readonly unregisterRightActions: (key: string) => void;
}

/**
 * Key for the landing terminal toggle as hosted by one start page. There is
 * exactly one window-wide panel, but its entry is keyed by the start page
 * HOSTING it: two mounted start pages are two presentation targets, and an
 * entry named only "the panel" would keep resolving - with the previous
 * page's toggle baked in - across the focus commit that moves the panel
 * between them.
 */
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
