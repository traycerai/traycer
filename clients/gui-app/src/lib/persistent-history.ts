import {
  createHistory,
  type HistoryLocation,
  type HistoryState,
  type RouterHistory,
} from "@tanstack/react-router";
import { appLogger, describeLogError } from "@/lib/logger";

/**
 * `ParsedHistoryState` is not exported from `@tanstack/react-router`, so we redeclare it here to type the callbacks passed to `createHistory` (whose `pushState`/`replaceState` arguments are declared as `any` upstream).
 */
type ParsedHistoryState = HistoryState & {
  readonly key?: string;
  readonly __TSR_key?: string;
  readonly __TSR_index: number;
};

/** Branded controller attached to the Electron renderer's persistent history. */
export interface PersistentHistoryController {
  getEntries(): ReadonlyArray<string>;
  /** The stable identity of each entry, positionally parallel to `getEntries`. */
  getEntryKeys(): ReadonlyArray<string | null>;
  getIndex(): number;
  canGoBack(): boolean; // index > 0 over the live stack
  canGoForward(): boolean; // index < entries.length - 1
  /**
   * Removes every NON-current entry for which `isDead(href)` is true, then collapses any adjacent byte-identical entries the removal left behind (or that were already present) so no two neighbouring entries ever share an href - two adjacent identical hrefs are.
   */
  prune(isDead: (href: string) => boolean): boolean;
  subscribe(cb: () => void): () => void;
}

/**
 * Unique-symbol brand.
 * Only `createPersistentMemoryHistory` stamps it, so a history that carries it is provably the Electron persistent history.
 */
export const PERSISTENT_HISTORY_CONTROLLER: unique symbol = Symbol(
  "traycer.persistentHistoryController",
);

/** The branded history returned by `createPersistentMemoryHistory`. */
export type PersistentRouterHistory = RouterHistory & {
  readonly [PERSISTENT_HISTORY_CONTROLLER]: PersistentHistoryController;
};

function isPersistentHistoryController(
  value: unknown,
): value is PersistentHistoryController {
  if (!isRecord(value)) return false;
  return (
    typeof value.getEntries === "function" &&
    typeof value.getEntryKeys === "function" &&
    typeof value.getIndex === "function" &&
    typeof value.canGoBack === "function" &&
    typeof value.canGoForward === "function" &&
    typeof value.prune === "function" &&
    typeof value.subscribe === "function"
  );
}

/**
 * Reads the controller back from the CURRENT router's history via the brand.
 * Returns `null` for the browser/memory histories (no brand), keeping the in-app navigation feature inert outside Electron.
 */
export function getHistoryController(
  history: RouterHistory,
): PersistentHistoryController | null {
  if (!(PERSISTENT_HISTORY_CONTROLLER in history)) return null;
  const candidate: unknown = history[PERSISTENT_HISTORY_CONTROLLER];
  return isPersistentHistoryController(candidate) ? candidate : null;
}

/** URL persistence for the Electron renderer. */

const STORAGE_KEY_PREFIX = "traycer-gui-app:last-route";
const CONSUMED_INITIAL_ROUTE_KEY_PREFIX =
  "traycer-gui-app:consumed-initial-route";
const MAX_ENTRIES = 100;

type LocationState = HistoryLocation["state"];

interface PersistedState {
  readonly entries: ReadonlyArray<string>;
  readonly index: number;
}

function buildStorageKey(windowId: string): string {
  return `${STORAGE_KEY_PREFIX}:${windowId}`;
}

function buildConsumedInitialRouteKey(
  windowId: string | null,
  initialRoute: string,
): string {
  return `${CONSUMED_INITIAL_ROUTE_KEY_PREFIX}:${windowId ?? "unknown"}:${initialRoute}`;
}

/**
 * Loads this window's remembered stack, or `null` when nothing usable is stored (no key, rejected shape, or read failure).
 * Returning `null` - rather than a `{ entries: ["/"], index: 0 }` default - lets the seed logic tell a genuinely empty window apart from one whose current entry happens to be `/`, which matters when merging a shell override into the remembered stack.
 */
function loadPersistedState(windowId: string | null): PersistedState | null {
  if (typeof window === "undefined") return null;
  if (windowId === null) return null;
  const storageKey = buildStorageKey(windowId);
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isPersistedState(parsed)) {
      appLogger.warn("[history] persisted route state rejected", {
        windowId,
      });
      removePersistedState(storageKey);
      return null;
    }
    const safeIndex = Math.min(
      Math.max(parsed.index, 0),
      parsed.entries.length - 1,
    );
    return { entries: parsed.entries, index: safeIndex };
  } catch (error) {
    appLogger.warn("[history] persisted route state load failed", {
      windowId,
      error: describeLogError(error),
    });
    removePersistedState(storageKey);
    return null;
  }
}

/**
 * Reads only this window's persisted cursor for legacy desktop migration.
 * It deliberately does not construct history or create tabs; callers use it solely as route proof for the History/Settings singleton import rule.
 */
export function readPersistedCurrentRoute(
  windowId: string | null,
): string | null {
  const persisted = loadPersistedState(windowId);
  if (persisted === null) return null;
  return persisted.entries[persisted.index] ?? null;
}

function removePersistedState(storageKey: string): void {
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // Keep route recovery best-effort; the load failure was already logged.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPersistedState(value: unknown): value is PersistedState {
  if (!isRecord(value)) return false;
  const entries = value.entries;
  if (!Array.isArray(entries)) return false;
  if (entries.length === 0) return false;
  if (!entries.every((e) => typeof e === "string" && e.length > 0)) {
    return false;
  }
  const index = value.index;
  if (typeof index !== "number") return false;
  if (!Number.isInteger(index)) return false;
  return true;
}

function persistState(
  windowId: string | null,
  entries: ReadonlyArray<string>,
  index: number,
): void {
  if (typeof window === "undefined") return;
  if (windowId === null) return;
  // Skip persisting when the current location is the bare landing `/`.
  // The landing is a transient state - fresh-launch seed AND the target of auth-fallback redirects (`requireSignedIn` → `redirect({ to: "/" })`).
  if (entries[index] === "/") return;
  try {
    // The in-memory stack is already bounded to MAX_ENTRIES by `capStackInPlace` (applied at every push and at seed), so persistence mirrors it verbatim.
    // Capping HERE instead would re-introduce a cursor/window mismatch: slicing from the tail while clamping the index independently can drop the current entry when the cursor sits outside the retained window.
    window.localStorage.setItem(
      buildStorageKey(windowId),
      JSON.stringify({ entries, index }),
    );
  } catch (error) {
    appLogger.warn("[history] persisted route state write failed", {
      windowId,
      entryCount: entries.length,
      error: describeLogError(error),
    });
    // localStorage unavailable (private mode, quota, disabled) - fail silent.
  }
}

function clearPersistedState(windowId: string | null): void {
  if (typeof window === "undefined") return;
  if (windowId === null) return;
  try {
    window.localStorage.removeItem(buildStorageKey(windowId));
  } catch (error) {
    appLogger.warn("[history] persisted route state clear failed", {
      windowId,
      error: describeLogError(error),
    });
    // localStorage unavailable (private mode, quota, disabled) - fail silent.
  }
}

function consumeShellOverride(
  initialRoute: string | null,
  windowId: string | null,
): string | null {
  if (initialRoute === null) return null;
  const normalized = normalizeRoute(initialRoute);
  if (windowId === null) return normalized;
  if (typeof window === "undefined") return normalized;
  try {
    const key = buildConsumedInitialRouteKey(windowId, normalized);
    if (window.sessionStorage.getItem(key) === "true") return null;
    window.sessionStorage.setItem(key, "true");
  } catch (error) {
    appLogger.warn("[history] initial route consume marker failed", {
      windowId,
      error: describeLogError(error),
    });
    // sessionStorage unavailable - keep the explicit route so boot still works.
  }
  return normalized;
}

function createRandomKey(): string {
  return (Math.random() + 1).toString(36).substring(7);
}

function makeInitialState(index: number): LocationState {
  const key = createRandomKey();
  return {
    key,
    __TSR_key: key,
    __TSR_index: index,
  };
}

function computePathnameEnd(
  href: string,
  searchIndex: number,
  hashIndex: number,
): number {
  if (hashIndex > 0 && searchIndex > 0) return Math.min(hashIndex, searchIndex);
  if (hashIndex > 0) return hashIndex;
  if (searchIndex > 0) return searchIndex;
  return href.length;
}

function parseHref(href: string, state: LocationState): HistoryLocation {
  const searchIndex = href.indexOf("?");
  const hashIndex = href.indexOf("#");
  const pathnameEnd = computePathnameEnd(href, searchIndex, hashIndex);
  return {
    href,
    pathname: href.substring(0, pathnameEnd),
    hash: hashIndex > -1 ? href.substring(hashIndex) : "",
    search:
      searchIndex > -1
        ? href.slice(searchIndex, hashIndex === -1 ? undefined : hashIndex)
        : "",
    state,
  };
}

function normalizeRoute(route: string | null): string {
  if (route === null) return "/";
  if (!route.startsWith("/")) return "/";
  return route;
}

/**
 * Bounds the in-memory stack to `MAX_ENTRIES` IN PLACE, keeping a contiguous window that always contains the current entry, and re-stamps `__TSR_index` to match the new array positions.
 */
/**
 * Re-stamp every entry's `__TSR_index` to its array position, so the stack stays contiguous after any structural mutation (push, cap, replace-collapse, prune).
 * Keeps `getLocation`'s `state.__TSR_index` aligned with the cursor for the next real navigation.
 */
function restampIndices(states: LocationState[]): void {
  const restamped: LocationState[] = states.map((entryState, i) => ({
    ...entryState,
    __TSR_index: i,
  }));
  states.splice(0, states.length, ...restamped);
}

function capStackInPlace(
  entries: string[],
  states: LocationState[],
  index: number,
): number {
  if (entries.length <= MAX_ENTRIES) return index;
  const start = Math.max(0, Math.min(entries.length - MAX_ENTRIES, index));
  entries.splice(0, start);
  entries.splice(MAX_ENTRIES);
  states.splice(0, start);
  states.splice(MAX_ENTRIES);
  restampIndices(states);
  return index - start;
}

interface PruneSurvivor {
  readonly href: string;
  readonly state: LocationState;
  readonly wasCurrent: boolean;
}

/**
 * Collapses adjacent byte-identical entries in a `prune`-filtered survivor list.
 * Two adjacent identical hrefs are always a dead back/forward step (`go(-1)`/`go(1)` moves the cursor but not the rendered location), so this runs unconditionally over the whole list - not just over runs the dead-entry filter just made adjacent.
 */
function collapseAdjacentDuplicates(
  survivors: ReadonlyArray<PruneSurvivor>,
): PruneSurvivor[] {
  return survivors.reduce<PruneSurvivor[]>((collapsed, entry) => {
    if (collapsed.length === 0) return [entry];
    const previous = collapsed[collapsed.length - 1];
    if (previous.href !== entry.href) {
      return [...collapsed, entry];
    }
    if (entry.wasCurrent) {
      // The CURRENT entry wins the collapse wholesale - state and key, not only the marker.
      // The prune is load-free, so the router's cached location keeps carrying the current entry's key; a survivor wearing the earlier entry's key would make everything filed against the cached identity (frozen-screen snapshots among it) unreachable, and could.
      collapsed[collapsed.length - 1] = entry;
    }
    return collapsed;
  }, []);
}

/**
 * Resolves the seed stack (entries + cursor) from the remembered stack and the shell override.
 * The override is MERGED into the remembered stack rather than replacing it, so a cold restore keeps the window's back/forward history:
 */
function computeSeededStack(
  persisted: PersistedState | null,
  shellOverride: string | null,
): { entries: string[]; index: number } {
  if (shellOverride === null) {
    if (persisted === null) return { entries: ["/"], index: 0 };
    return { entries: [...persisted.entries], index: persisted.index };
  }
  if (shellOverride === "/") return { entries: ["/"], index: 0 };
  if (persisted === null) return { entries: [shellOverride], index: 0 };
  if (persisted.entries[persisted.index] === shellOverride) {
    return { entries: [...persisted.entries], index: persisted.index };
  }
  return {
    entries: [
      ...persisted.entries.slice(0, persisted.index + 1),
      shellOverride,
    ],
    index: persisted.index + 1,
  };
}

/**
 * Creates a router history the app OWNS - entries, index, and the controller brand that lets `goBack` / `goForward` step it semantically - for the two shells that have no browser to own one for them.
 */
export function createPersistentMemoryHistory(
  initialRoute: string | null,
  windowId: string | null,
): PersistentRouterHistory {
  const persisted = loadPersistedState(windowId);
  const shellOverride = consumeShellOverride(initialRoute, windowId);
  if (shellOverride === "/") {
    // A bare-`/` shell override is the deliberate "start at the landing" signal: the zero-restorable-windows cold start and the auth-fallback redirect both funnel through it.
    // Discard the remembered stack rather than merging - the landing is meant to be a clean start, not the tail of a deep back-history to routes the snapshot no longer references.
    clearPersistedState(windowId);
  }

  const seed = computeSeededStack(persisted, shellOverride);
  const entries: string[] = seed.entries;
  const states: LocationState[] = entries.map((_entry, i) =>
    makeInitialState(i),
  );
  let index = seed.index;
  // Bound a legacy/oversized seed before anything reads the stack.
  index = capStackInPlace(entries, states, index);

  let blockers: Parameters<
    NonNullable<Parameters<typeof createHistory>[0]["setBlockers"]>
  >[0] = [];

  // Controller-only subscriber store.
  // Poked by the navigation callbacks below and by `prune`, so navigability recomputes without ever calling `history.notify()` (which would drive `router.load()`).
  const controllerSubscribers = new Set<() => void>();
  const notifyController = () => {
    controllerSubscribers.forEach((cb) => cb());
  };

  persistState(windowId, entries, index);

  const history = createHistory({
    getLocation: () =>
      parseHref(
        entries[index] ?? "/",
        states[index] ?? makeInitialState(index),
      ),
    getLength: () => entries.length,
    pushState: (path: string, state: ParsedHistoryState) => {
      if (index < entries.length - 1) {
        entries.splice(index + 1);
        states.splice(index + 1);
      }
      // The pushed href can land byte-identical to the entry the cursor now sits on (e.g. a pane close's prepared fallback-focus push re-deriving the tab it came from).
      // Two adjacent identical hrefs are always a dead back step, so treat this as landing on the existing entry instead of manufacturing a duplicate - general adjacent-duplicate guard, mirrors the collapse in `replaceState`.
      if (entries[index] === path) {
        states[index] = state;
        restampIndices(states);
        persistState(windowId, entries, index);
        notifyController();
        return;
      }
      entries.push(path);
      states.push(state);
      index = entries.length - 1;
      // Cap at the point of growth: the cursor is the tail here, so the
      // front-drop can never remove the current entry.
      index = capStackInPlace(entries, states, index);
      // Re-stamp unconditionally: TanStack derives the pushed `__TSR_index` from its CACHED `location`, which a prior load-free `prune` (it never calls `history.notify()`) may have left stale.
      restampIndices(states);
      persistState(windowId, entries, index);
      notifyController();
    },
    replaceState: (path: string, state: ParsedHistoryState) => {
      entries[index] = path;
      states[index] = state;
      // Collapse an adjacent byte-identical entry created by an in-place replace, on EITHER side of the current entry.
      // Two identical adjacent entries are always a dead back/forward step (`go(-1)`/`go(1)` moves the cursor but not the rendered href), so dropping the redundant neighbour is correct for ANY replace - this is a general adjacent-duplicate guard, not overlay-specific.
      if (index > 0 && entries[index - 1] === path) {
        entries.splice(index - 1, 1);
        states.splice(index - 1, 1);
        index -= 1;
      }
      if (index < entries.length - 1 && entries[index + 1] === path) {
        entries.splice(index + 1, 1);
        states.splice(index + 1, 1);
      }
      // Unconditionally, not only after a collapse: the replaced state arrives carrying TanStack's CACHED `__TSR_index`, which a prior load-free `prune` (it never calls `history.notify()`) may have left stale - the same reason the push path re-stamps unconditionally.
      restampIndices(states);
      persistState(windowId, entries, index);
      notifyController();
    },
    back: () => {
      index = Math.max(index - 1, 0);
      persistState(windowId, entries, index);
      notifyController();
    },
    forward: () => {
      index = Math.min(index + 1, entries.length - 1);
      persistState(windowId, entries, index);
      notifyController();
    },
    go: (n) => {
      index = Math.min(Math.max(index + n, 0), entries.length - 1);
      persistState(windowId, entries, index);
      notifyController();
    },
    createHref: (path) => path,
    getBlockers: () => blockers,
    setBlockers: (newBlockers) => {
      blockers = newBlockers;
    },
  });

  const controller: PersistentHistoryController = {
    getEntries: () => [...entries],
    getEntryKeys: () =>
      states.map((entryState) => {
        if (typeof entryState.__TSR_key === "string") {
          return entryState.__TSR_key;
        }
        return typeof entryState.key === "string" ? entryState.key : null;
      }),
    getIndex: () => index,
    canGoBack: () => index > 0,
    canGoForward: () => index < entries.length - 1,
    prune: (isDead) => {
      // Keep the current entry unconditionally; drop any other entry the caller proves dead.
      // `survivors` carries the original state + a current marker so the index can be remapped after filtering.
      const survivors = entries
        .map((href, i) => ({ href, state: states[i], wasCurrent: i === index }))
        .filter((entry) => {
          if (entry.wasCurrent) {
            return true;
          }
          return !isDead(entry.href);
        });

      // Collapse any adjacent byte-identical entries the dead-entry removal left behind (or that were already present), so the stack never ends up with two neighbouring entries that render the same location - a dead back/forward step.
      const collapsed = collapseAdjacentDuplicates(survivors);

      // Current is never pruned, and a collapse never drops the sole surviving current marker, so an unchanged length means nothing changed at all (neither dead-entry removal nor collapse).
      if (collapsed.length === entries.length) return false;

      const nextIndex = collapsed.findIndex((entry) => entry.wasCurrent);
      // Mutate the closed-over arrays in place so `getLocation` keeps reading the same references the history was created with, then re-stamp `__TSR_index` contiguously so the next real `go(n)` lands on a location whose `state` index matches its array position.
      entries.splice(
        0,
        entries.length,
        ...collapsed.map((entry) => entry.href),
      );
      states.splice(0, states.length, ...collapsed.map((entry) => entry.state));
      restampIndices(states);
      index = nextIndex;

      persistState(windowId, entries, index);
      notifyController();
      return true;
    },
    subscribe: (cb) => {
      controllerSubscribers.add(cb);
      return () => {
        controllerSubscribers.delete(cb);
      };
    },
  };

  const branded = Object.assign(history, {
    [PERSISTENT_HISTORY_CONTROLLER]: controller,
  });
  // Make the brand non-enumerable / non-writable / non-configurable: a shallow clone (`{ ...history }`) must NOT copy it (a copy would carry a controller bound to THIS closure's `entries`/`states`, diverging from the clone's own navigation), and it can't be.
  Object.defineProperty(branded, PERSISTENT_HISTORY_CONTROLLER, {
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return branded;
}
