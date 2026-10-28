import { createContext, useContext } from "react";
import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";

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

/** @see BrowserSessionsSnapshotContext */
export interface BrowserSessionsSnapshot {
  readonly current: BrowserSessionsState | null;
}

/**
 * A STABLE handle onto the same value {@link BrowserSessionsContext} carries,
 * for consumers that only need it inside an event handler.
 *
 * Reading the context itself re-renders on every sessions-stream frame (see
 * the note on `BrowserSessionsCoordinatorKeyContext` above); `useOpenBrowserUrl`
 * is mounted by ~30 link surfaces at once and wants the sessions ONLY at click
 * time, so it reads `.current` off this ref instead. The ref object identity
 * never changes, so consuming this context subscribes to nothing.
 */
export const BrowserSessionsSnapshotContext =
  createContext<BrowserSessionsSnapshot | null>(null);

export function useMaybeBrowserSessionsSnapshot(): BrowserSessionsSnapshot | null {
  return useContext(BrowserSessionsSnapshotContext);
}

/**
 * The same kind of stable handle, onto the sessions of the host a browser the
 * person opens from this canvas tab goes to (`useBrowserOpenHost`). `current`
 * is null when neither a Browsers panel pin nor a local host picks one; an open
 * then goes to {@link BrowserSessionsSnapshotContext}'s host, as before.
 *
 * Its own context because every tile re-provides the snapshot above for the
 * TILE's host, and the open host has to reach through that.
 */
export const BrowserOpenSessionsSnapshotContext =
  createContext<BrowserSessionsSnapshot | null>(null);

export function useMaybeBrowserOpenSessionsSnapshot(): BrowserSessionsSnapshot | null {
  return useContext(BrowserOpenSessionsSnapshotContext);
}
