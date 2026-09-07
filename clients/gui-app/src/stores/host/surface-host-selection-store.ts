import { create } from "zustand";
import {
  createJSONStorage,
  persist,
  type PersistStorage,
} from "zustand/middleware";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { basePersistOptions, surfaceHostSelectionKey } from "@/lib/persist";

/**
 * Per-surface host pin. `null` means follow `effective` (selection model §2).
 * The store's public shape is final; P1.2 swaps only the `effective` backing.
 */
export type SurfaceHostSelection = string | null;

/** Multi-instance surfaces key by instance; singletons would use a type-level instance id. */
export type SurfaceKind =
  | "git-diff"
  | "file-tree"
  | "new-terminal"
  | "browsers"
  | "composer"
  | "new-conversation";

const SURFACE_KEY_SEP = "\u001f";

export const BROWSER_SURFACE_WINDOW_ID = "browser";

export function resolveSurfaceWindowId(windowId: string | null): string {
  return windowId !== null && windowId.length > 0
    ? windowId
    : BROWSER_SURFACE_WINDOW_ID;
}

export function surfaceHostKey(kind: SurfaceKind, instanceId: string): string {
  return `${kind}${SURFACE_KEY_SEP}${instanceId}`;
}

/** Sidebar panel instance: the view tab id. */
export function tabSurfaceKey(
  kind: Extract<
    SurfaceKind,
    "git-diff" | "file-tree" | "new-terminal" | "browsers"
  >,
  tabId: string,
): string {
  return surfaceHostKey(kind, tabId);
}

/** Git-diff sidebar panel instance. `tileRef` is the view tab id. */
export function gitDiffPanelSurfaceKey(tileRef: string): string {
  return tabSurfaceKey("git-diff", tileRef);
}

/** The landing composer's window-keyed placement pin (P1.2 §55). Accepts null so the contract matches `resolveSurfaceWindowId`. */
export function composerSurfaceKey(windowId: string | null): string {
  return surfaceHostKey("composer", resolveSurfaceWindowId(windowId));
}

/** The in-Epic new-conversation modal's placement pin: one per EPIC, on every device that opens it. */
export function newConversationSurfaceKey(epicId: string): string {
  return surfaceHostKey("new-conversation", epicId);
}

/**
 * What this window's selection authority has published about the fleet, as the pin resolver needs
 * it.
 */
export interface SurfacePinFleetView {
  /** `useSelectionAuthorityAttached()` - false before the kernel speaks. */
  readonly authorityAttached: boolean;
  /** `useHostLeases()` - one lease per fleet host, empty before attach. */
  readonly leases: readonly HostLeaseSnapshot[];
}

/**
 * Whether a pin has been DEPOSED - the pinned host cannot serve this surface right now, so
 * resolution falls through to `effective` until it can again.
 */
export function isSurfacePinDeposed(
  pinnedHostId: string,
  fleet: SurfacePinFleetView,
): boolean {
  if (!fleet.authorityAttached) return false;
  if (fleet.leases.length === 0) return false;
  const lease = fleet.leases.find((entry) => entry.hostId === pinnedHostId);
  if (lease === undefined) return true;
  return lease.status === "dead";
}

/**
 * The host a surface acts on: its pin while that pin can serve, `effective` while it cannot. The
 * pin itself is NEVER cleared by death - that is what makes the return sticky.
 */
export function resolvedSurfaceHostId(
  selection: SurfaceHostSelection,
  effectiveHostId: string | null,
  fleet: SurfacePinFleetView,
): string | null {
  if (selection === null) return effectiveHostId;
  if (isSurfacePinDeposed(selection, fleet)) return effectiveHostId;
  return selection;
}

/** Whether the fleet is known well enough to conclude a host has LEFT it. */
export function isSurfacePinFleetKnown(fleet: SurfacePinFleetView): boolean {
  return fleet.authorityAttached && fleet.leases.length > 0;
}

export type FollowingSurfaceResetListener = (input: {
  readonly previousEffectiveHostId: string | null;
  readonly nextEffectiveHostId: string | null;
}) => void;

const followingSurfaceResetListeners = new Set<FollowingSurfaceResetListener>();

/** G4 reset-dependent-state hook point. */
export function subscribeFollowingSurfaceReset(
  listener: FollowingSurfaceResetListener,
): () => void {
  followingSurfaceResetListeners.add(listener);
  return () => {
    followingSurfaceResetListeners.delete(listener);
  };
}

/**
 * Invoke after `effective` changes. P1.2 is the first caller. Pinned
 * instances ignore this - they keep their pin (D6).
 */
export function notifyEffectiveHostChanged(
  previousEffectiveHostId: string | null,
  nextEffectiveHostId: string | null,
): void {
  if (previousEffectiveHostId === nextEffectiveHostId) return;
  for (const listener of followingSurfaceResetListeners) {
    listener({ previousEffectiveHostId, nextEffectiveHostId });
  }
}

interface SurfaceHostSelectionStoreState {
  readonly selections: Readonly<Partial<Record<string, string>>>;
  readonly setSelection: (
    surfaceKey: string,
    selection: SurfaceHostSelection,
  ) => void;
  /** Carries a selection from one surface key to another, and clears the source. */
  readonly migrateSelection: (fromKey: string, toKey: string) => void;
  /**
   * G4 latch-on-first-use for the tree/diff class: if this instance is still following, pin it to
   * `resolvedHostId` so a later failover cannot swap the tree underneath.
   */
  readonly latchOnFirstUse: (
    surfaceKey: string,
    resolvedHostId: string,
  ) => void;
  /** Deliberate deregistration clears pins; mere death never does. */
  readonly clearPinsForHost: (hostId: string) => void;
  readonly resetForTests: () => void;
}

function persistedSelections(
  persistedState: unknown,
): Readonly<Partial<Record<string, string>>> {
  if (typeof persistedState !== "object" || persistedState === null) {
    return {};
  }
  if (!("selections" in persistedState)) return {};
  const selections = persistedState.selections;
  if (typeof selections !== "object" || selections === null) {
    return {};
  }
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(selections)) {
    if (key.length === 0) continue;
    if (typeof value !== "string" || value.length === 0) continue;
    next[key] = value;
  }
  return next;
}

type SurfaceSelectionMap = Readonly<Partial<Record<string, string>>>;

interface PersistedSurfaceSelections {
  readonly selections: SurfaceSelectionMap;
}

/**
 * A `localStorage` view that MERGES every write against what is already stored, instead of
 * replacing it. WHY.
 */
function crossWindowSafeStorage(): PersistStorage<PersistedSurfaceSelections> {
  const inner = createJSONStorage<PersistedSurfaceSelections>(
    () => window.localStorage,
  );
  if (inner === undefined) {
    throw new Error("surface host selection store needs a JSON storage");
  }
  // This instance's last known map - the base of the three-way merge. Seeded
  // on hydration, replaced on every write.
  let base: SurfaceSelectionMap = {};
  return {
    getItem: (name) => {
      const stored = inner.getItem(name);
      if (stored instanceof Promise) {
        throw new Error("surface host selection storage must be synchronous");
      }
      if (stored !== null) base = { ...stored.state.selections };
      return stored;
    },
    setItem: (name, value) => {
      const current = inner.getItem(name);
      if (current instanceof Promise) {
        throw new Error("surface host selection storage must be synchronous");
      }
      const own = value.state.selections;
      // ONLY THE KEYS THIS INSTANCE ACTUALLY CHANGED are written; the rest of `own` is stale hydrated
      // state and must assert nothing.
      const merged: Partial<Record<string, string>> =
        current === null ? {} : { ...current.state.selections };
      for (const surfaceKey of Object.keys(own)) {
        if (own[surfaceKey] !== base[surfaceKey]) {
          merged[surfaceKey] = own[surfaceKey];
        }
      }
      for (const surfaceKey of Object.keys(base)) {
        if (!(surfaceKey in own)) delete merged[surfaceKey];
      }
      base = { ...own };
      return inner.setItem(name, {
        ...value,
        state: { selections: merged },
      });
    },
    removeItem: (name) => {
      base = {};
      return inner.removeItem(name);
    },
  };
}

export const useSurfaceHostSelectionStore =
  create<SurfaceHostSelectionStoreState>()(
    persist(
      (set, get) => ({
        selections: {},
        setSelection: (surfaceKey, selection) => {
          const current = get().selections;
          const existing = current[surfaceKey];
          if (selection === null) {
            if (existing === undefined) return;
            const next = { ...current };
            delete next[surfaceKey];
            set({ selections: next });
            return;
          }
          if (existing === selection) return;
          set({ selections: { ...current, [surfaceKey]: selection } });
        },
        migrateSelection: (fromKey, toKey) => {
          if (fromKey === toKey) return;
          const current = get().selections;
          const moving = current[fromKey];
          if (moving === undefined) return;
          const next = { ...current };
          delete next[fromKey];
          if (current[toKey] === undefined) next[toKey] = moving;
          set({ selections: next });
        },
        latchOnFirstUse: (surfaceKey, resolvedHostId) => {
          if (resolvedHostId.length === 0) return;
          const current = get().selections;
          if (current[surfaceKey] !== undefined) return;
          set({ selections: { ...current, [surfaceKey]: resolvedHostId } });
        },
        clearPinsForHost: (hostId) => {
          if (hostId.length === 0) return;
          const current = get().selections;
          const next: Record<string, string> = {};
          let removed = false;
          for (const [surfaceKey, pinnedHostId] of Object.entries(current)) {
            if (pinnedHostId === undefined) continue;
            if (pinnedHostId === hostId) {
              removed = true;
              continue;
            }
            next[surfaceKey] = pinnedHostId;
          }
          // No-op writes would notify every subscribed surface on every fleet
          // publish, which is most of them, most of the time.
          if (!removed) return;
          set({ selections: next });
        },
        resetForTests: () => {
          set({ selections: {} });
        },
      }),
      {
        ...basePersistOptions(surfaceHostSelectionKey(null)),
        storage: crossWindowSafeStorage(),
        merge: (persistedState, currentState) => ({
          ...currentState,
          selections: persistedSelections(persistedState),
        }),
        partialize: (state) => ({ selections: state.selections }),
      },
    ),
  );
