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

/**
 * Multi-instance surfaces key by instance; singletons would use a type-level
 * instance id. Sidebar panels (git-diff, file-tree, new-terminal) all use
 * the view tab id — tab ids are uuid-unique app-wide, so a tab that moves
 * windows keeps its pins. `composer` is the landing composer's placement pin,
 * keyed per WINDOW (P1.2 §55). `new-conversation` is the in-Epic
 * new-conversation modal's placement pin, keyed per EPIC: it is that Epic's
 * "last created chat's host" memory (recorded on every create, and by its
 * picker), the host analogue of the per-Epic model memory the modal already
 * keeps - see `useEpicConversationPlacement`.
 */
export type SurfaceKind =
  "git-diff" | "file-tree" | "new-terminal" | "composer" | "new-conversation";

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
  kind: Extract<SurfaceKind, "git-diff" | "file-tree" | "new-terminal">,
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

/**
 * The in-Epic new-conversation modal's placement pin: one per EPIC, on every
 * device that opens it. Deliberately NOT the window-keyed `composer` pin the
 * modal used to share with the landing composer: the two never show at once
 * (the modal always has an Epic behind it, the landing composer never does),
 * so nothing was kept in agreement by sharing - and the sharing made "where
 * does a new agent in THIS Epic go" answer with wherever the window's landing
 * chip last pointed, which is not a fact about the Epic.
 */
export function newConversationSurfaceKey(epicId: string): string {
  return surfaceHostKey("new-conversation", epicId);
}

/**
 * What this window's selection authority has published about the fleet, as
 * the pin resolver needs it. Passed in rather than read here so the rule
 * below stays a pure function a test can drive without a store.
 */
export interface SurfacePinFleetView {
  /** `useSelectionAuthorityAttached()` - false before the kernel speaks. */
  readonly authorityAttached: boolean;
  /** `useHostLeases()` - one lease per fleet host, empty before attach. */
  readonly leases: readonly HostLeaseSnapshot[];
}

/**
 * Whether a pin has been DEPOSED - the pinned host cannot serve this surface
 * right now, so resolution falls through to `effective` until it can again.
 *
 * This is the per-surface miniature of the app's preferred/effective pair, and
 * it derives from exactly the vocabulary the app-wide failover derives from:
 * the lease. Three rules, each load-bearing in a different direction.
 *
 * **Positive evidence only.** A `null` lease is not death - it is what every
 * host reads before the kernel attaches, and what a host outside the account's
 * fleet reads forever. Reading absence as death would re-point every pinned
 * surface to `effective` during every cold start, which is both the
 * false-Offline class this epic exists to delete and a silent discard of the
 * user's placement. Hence the `authorityAttached` and non-empty guards: they
 * are the same "absence of an answer is not an answer" rule the engine writes
 * as `clearPreferredOutsideFleet`'s empty-fleet guard.
 *
 * **`dead` only, never `!isUsableForSelection`.** That predicate is also false
 * for `restarting-expected`, and the difference is the whole point: the engine
 * HOLDS its effective host across an expected restart rather than dragging the
 * user onto a third machine for 15-30s. A pin is an incumbent, not a
 * candidate, so it holds too. "Auto switch just like the global host failover"
 * means the failover's behaviour, and the failover does not move here.
 *
 * **A host absent from a known fleet is gone, not merely quiet.** Leases are
 * enumerated from the fleet, and a deregistered host's lease VANISHES rather
 * than turning `dead("removed")` - that is the contract's design, with
 * `clearPreferredOutsideFleet` owning the selection consequence. Without this
 * arm a pin whose host was deregistered while its surface was unmounted would
 * be served on the next mount, addressing a machine that no longer exists,
 * until the prune effect caught up a render later.
 *
 * Known exposure, deliberately mirrored rather than fixed here: the fleet is
 * the ACCOUNT REGISTRY plus this machine's synthesized local id, so a host the
 * runtime directory can dial but the registry has not listed ("hasn't reported
 * to your account yet") reads as absent. `clearPreferredOutsideFleet` has the
 * same exposure for the preferred host and accepts it; diverging here would
 * give the two tiers different membership rules.
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
 * The host a surface acts on: its pin while that pin can serve, `effective`
 * while it cannot.
 *
 * The pin itself is NEVER cleared by death - that is what makes the return
 * sticky. When the pinned host's lease is usable again this answers the pin
 * again, with no user gesture and nothing to restore.
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

/**
 * Whether the fleet is known well enough to conclude a host has LEFT it.
 * The prune below and {@link isSurfacePinDeposed}'s absence arm must agree on
 * this, or a pin could resolve away without ever being cleared.
 */
export function isSurfacePinFleetKnown(fleet: SurfacePinFleetView): boolean {
  return fleet.authorityAttached && fleet.leases.length > 0;
}

export type FollowingSurfaceResetListener = (input: {
  readonly previousEffectiveHostId: string | null;
  readonly nextEffectiveHostId: string | null;
}) => void;

const followingSurfaceResetListeners = new Set<FollowingSurfaceResetListener>();

/**
 * G4 reset-dependent-state hook point. Phase 1 registers consumers that
 * clear host-dependent UI (worktree, folder, branch) when a *following*
 * surface re-points. Additive: nothing calls `notifyEffectiveHostChanged`
 * until derivation actually moves.
 */
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
 * instances ignore this — they keep their pin (D6).
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
  /**
   * Carries a selection from one surface key to another, and clears the
   * source.
   *
   * For a surface whose KEY can change under a stable surface - today only the
   * browser composer, whose tab identity rotates when a duplicated tab claims
   * the same id. The tab that rotates is the ORIGINAL, so without this its own
   * placement is dropped on the floor at the moment of the collision, while the
   * duplicate inherits the old key and reads a pin it never chose. Clearing the
   * source is therefore half the fix, not tidiness.
   *
   * Refuses to overwrite a selection already at `toKey`: that is a decision
   * made under the new identity and outranks one carried from the old one.
   */
  readonly migrateSelection: (fromKey: string, toKey: string) => void;
  /**
   * G4 latch-on-first-use for the tree/diff class: if this instance is
   * still following, pin it to `resolvedHostId` so a later failover cannot
   * swap the tree underneath.
   */
  readonly latchOnFirstUse: (
    surfaceKey: string,
    resolvedHostId: string,
  ) => void;
  /**
   * Deliberate deregistration clears pins; mere death never does. The pair is
   * the whole product rule: a host that went offline is coming back, so the
   * pin waits for it, while a host removed from the account is not, so a pin
   * naming it is a pointer to nothing.
   *
   * Every surface pinned to `hostId` is cleared, not just the caller's - the
   * host left the account for all of them at once.
   *
   * The CALLER owns the "is it really gone" question
   * ({@link isSurfacePinFleetKnown}); this is the write.
   */
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
 * A `localStorage` view that MERGES every write against what is already
 * stored, instead of replacing it.
 *
 * WHY. Every window runs its own instance of this store, and they all persist
 * to one account-scoped key - the whole `selections` map, every time. A window
 * only knows the pins it hydrated with, so the second window to write erased
 * the first window's newer pin, and the loss only became visible after the
 * first window reloaded and its composer or sidebar silently followed
 * `effective` instead of the host the user had chosen. Per-window surface keys
 * do not help: distinct keys still share one stored object.
 *
 * A UNION IS NOT THE FIX, and this is the part worth reading before
 * simplifying. Unpin and `clearPinsForHost` are expressed as ABSENCE - the key
 * is gone from the writer's map - so merging by union alone would resurrect
 * every pin the user just cleared, turning a lost-write bug into an
 * undeletable one.
 *
 * So the merge is three-way, with this instance's PREVIOUS map as the base.
 * Only keys that CHANGED against that base are written - added, updated, or
 * dropped; everything else in this instance's map is stale hydrated state
 * about which it has no opinion, and storage stands. Same-key conflicts
 * resolve to the writer, which is correct because the writer is the window
 * that just acted.
 *
 * Ownership is deliberately not inferred from the key. Sidebar surfaces are
 * keyed by TAB id precisely so a tab keeps its pins when it moves windows, so
 * no key prefix identifies the window that owns it - the base map does.
 *
 * Reads are not merged and do not need to be: hydration reads the stored map
 * whole, which is already the union of every window's writes.
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
      // ONLY THE KEYS THIS INSTANCE ACTUALLY CHANGED are written; the rest of
      // `own` is stale hydrated state and must assert nothing.
      //
      // Spreading `own` wholesale was the earlier version's bug, and it was the
      // mirror of the one this merge exists to fix: two windows hydrate pin
      // `x`, window B unpins it and persists the deletion, and then ANY
      // unrelated write from window A - which still carries `x` in memory -
      // republished it. `x` also survived the deletion loop, because it was
      // still present in `own`. So an explicit return-to-following was undone
      // by ordinary activity in another window.
      //
      // A key equal in `base` and `own` was not touched between these two
      // writes, so this instance has no opinion about it and whatever storage
      // holds - including its absence - stands.
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
