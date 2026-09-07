/** Moving the hook into a component that lives in the route tree makes the requirement structural. */
import type { HeaderTab } from "@/stores/tabs/types";

export interface TabDetachHandler {
  /** Distinct from the handler's existence: this is the owner's answer, not the question of whether an owner
   * exists. */
  readonly isAvailable: boolean;
  readonly requestOpen: (tab: HeaderTab) => void;
}

let handler: TabDetachHandler | null = null;

/** Called by the route-tree owner on mount and whenever the flow identity changes; returns the unsubscribe so
 * the owner can withdraw it. */
export function publishTabDetachHandler(next: TabDetachHandler): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

/** Callers must distinguish the two; see the module comment. */
export function readTabDetachHandler(): TabDetachHandler | null {
  return handler;
}

export function resetTabDetachHandler(): void {
  handler = null;
}
