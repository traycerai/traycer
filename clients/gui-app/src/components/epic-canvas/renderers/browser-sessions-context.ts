import { createContext, useContext } from "react";
import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";

export type { BrowserSessionsLifecycle } from "@/lib/browser-view/sessions/browser-sessions-stream";
export type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";

export const BrowserSessionsContext =
  createContext<BrowserSessionsState | null>(null);

export function useMaybeBrowserSessionsContext(): BrowserSessionsState | null {
  return useContext(BrowserSessionsContext);
}

export function useBrowserSessionsContext(): BrowserSessionsState {
  const value = useMaybeBrowserSessionsContext();
  if (value === null) {
    throw new Error("BrowserSessionsProvider is not mounted.");
  }
  return value;
}

/**
 * The coordinator's registry key, set once per host/epic/owner and STABLE
 * across every sessions-stream frame - unlike `BrowserSessionsContext`, whose
 * value is a fresh object every frame (`browser-sessions-coordinator.ts`'s
 * `patchState` spreads state on each server frame). A consumer that only
 * needs to read the coordinator's state passively (not on every render) reads
 * it via this key against `browserSessionsCoordinatorState` /
 * `subscribeToBrowserSessionsCoordinator` at query time, instead of
 * subscribing through the churning context value. See
 * `use-mention-items.ts`'s browser-tab source for the consumer.
 */
export const BrowserSessionsCoordinatorKeyContext = createContext<
  string | null
>(null);

export function useMaybeBrowserSessionsCoordinatorKey(): string | null {
  return useContext(BrowserSessionsCoordinatorKeyContext);
}
