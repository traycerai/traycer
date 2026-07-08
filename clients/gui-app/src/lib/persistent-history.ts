import {
  createHistory,
  type HistoryLocation,
  type HistoryState,
  type RouterHistory,
} from "@tanstack/react-router";
import { appLogger, describeLogError } from "@/lib/logger";

/**
 * `ParsedHistoryState` is not exported from `@tanstack/react-router`, so we
 * redeclare it here to type the callbacks passed to `createHistory` (whose
 * `pushState`/`replaceState` arguments are declared as `any` upstream).
 * Mirrors the shape from `@tanstack/history` exactly: the augmentable
 * `HistoryState` interface plus the three `__TSR_*` fields the router
 * stamps onto every entry.
 */
type ParsedHistoryState = HistoryState & {
  readonly key?: string;
  readonly __TSR_key?: string;
  readonly __TSR_index: number;
};

/**
 * Branded controller attached to the Electron renderer's persistent history.
 *
 * It owns the persisted stack and exposes a **load-free** read/maintenance
 * surface for in-app back/forward navigation:
 *
 * - `getEntries` / `getIndex` snapshot the current stack.
 * - `canGoBack` / `canGoForward` derive navigability from `index` over the live
 *   stack.
 * - `prune` drops unreachable (non-current) entries WITHOUT touching the router.
 * - `subscribe` is a tiny store that recomputes navigability after a prune AND
 *   after every real navigation, without ever forcing `router.load()`.
 *
 * Real navigation still goes through `history.go/back/forward` (which notify the
 * router); the controller never calls `history.notify()`.
 */
export interface PersistentHistoryController {
  getEntries(): ReadonlyArray<string>;
  getIndex(): number;
  canGoBack(): boolean; // index > 0 over the live stack
  canGoForward(): boolean; // index < entries.length - 1
  /**
   * Removes every NON-current entry for which `isDead(href)` is true, remaps the
   * index to the surviving current entry, re-stamps `__TSR_index` contiguously,
   * persists, and notifies CONTROLLER subscribers only. Returns whether the
   * stack changed.
   *
   * Critically load-free: it never calls `history.notify()` and so never drives
   * `router.load()`. The current entry is never pruned.
   */
  prune(isDead: (href: string) => boolean): boolean;
  subscribe(cb: () => void): () => void;
}

/**
 * Unique-symbol brand. Only `createPersistentMemoryHistory` stamps it, so a
 * history that carries it is provably the Electron persistent history.
 * `createBrowserHistory` / `createMemoryHistory` never carry it, which is the
 * single signal that gates the in-app navigation feature.
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
    typeof value.getIndex === "function" &&
    typeof value.canGoBack === "function" &&
    typeof value.canGoForward === "function" &&
    typeof value.prune === "function" &&
    typeof value.subscribe === "function"
  );
}

/**
 * Reads the controller back from the CURRENT router's history via the brand.
 * Returns `null` for the browser/memory histories (no brand), keeping the in-app
 * navigation feature inert outside Electron. Uses a runtime type guard so no
 * unsafe cast is needed.
 */
export function getHistoryController(
  history: RouterHistory,
): PersistentHistoryController | null {
  if (!(PERSISTENT_HISTORY_CONTROLLER in history)) return null;
  const candidate: unknown = history[PERSISTENT_HISTORY_CONTROLLER];
  return isPersistentHistoryController(candidate) ? candidate : null;
}

/**
 * URL persistence for the Electron renderer.
 *
 * The browser web app uses TanStack's default `createBrowserHistory`, which
 * picks up the current URL from `window.location` on every load and survives
 * reloads naturally (the URL bar is the source of truth, and shared deep
 * links work out of the box).
 *
 * Electron renderers boot under the `app://` or `file://` scheme with no
 * visible URL bar and no path carried across launches, so a window's previous
 * route would otherwise be lost when no explicit shell route is provided. This
 * module owns a small per-window history stack, mirrors it into `localStorage`
 * on every push/replace/back/forward, and seeds the stack from `localStorage`
 * at module init. The read is synchronous, so the router boots with zero
 * render flash - no async hydration gate required.
 *
 * Pattern mirrors superset's `persistent-hash-history.ts` (we verified the
 * shape against that implementation): use TanStack's `createHistory`
 * primitive, drive entries[] + index explicitly, persist inside each
 * navigation method. Relying on `createMemoryHistory().subscribe()` was
 * unreliable in practice.
 */

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
 * Loads this window's remembered stack, or `null` when nothing usable is
 * stored (no key, rejected shape, or read failure). Returning `null` - rather
 * than a `{ entries: ["/"], index: 0 }` default - lets the seed logic tell a
 * genuinely empty window apart from one whose current entry happens to be `/`,
 * which matters when merging a shell override into the remembered stack.
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
  // The landing is a transient state - fresh-launch seed AND the target of
  // auth-fallback redirects (`requireSignedIn` → `redirect({ to: "/" })`).
  // If we persisted `/` writes, those mid-session redirects would clobber
  // the user's real last-visited route and the next launch would restore
  // to `/` instead of where the user actually was.
  if (entries[index] === "/") return;
  try {
    // The in-memory stack is already bounded to MAX_ENTRIES by `capStackInPlace`
    // (applied at every push and at seed), so persistence mirrors it verbatim.
    // Capping HERE instead would re-introduce a cursor/window mismatch: slicing
    // from the tail while clamping the index independently can drop the current
    // entry when the cursor sits outside the retained window.
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
 * Bounds the in-memory stack to `MAX_ENTRIES` IN PLACE, keeping a contiguous
 * window that always contains the current entry, and re-stamps `__TSR_index` to
 * match the new array positions. Returns the remapped index.
 *
 * This is the single place the stack is bounded. Capping at the point of growth
 * (every `push`, where the cursor is always the tail) means the front-drop never
 * removes the current entry. The window is anchored on `index` rather than on
 * the tail, so seeding a legacy/oversized persisted stack while the cursor sits
 * deep in the back history still retains the current entry instead of dropping
 * it and restoring the wrong route on next launch.
 */
/**
 * Re-stamp every entry's `__TSR_index` to its array position, so the stack stays
 * contiguous after any structural mutation (push, cap, replace-collapse, prune).
 * Keeps `getLocation`'s `state.__TSR_index` aligned with the cursor for the next
 * real navigation. The single owner of the re-stamp invariant.
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

/**
 * Resolves the seed stack (entries + cursor) from the remembered stack and the
 * shell override. The override is MERGED into the remembered stack rather than
 * replacing it, so a cold restore keeps the window's back/forward history:
 *
 * - No override → restore the remembered stack verbatim (or the bare landing
 *   when nothing is stored).
 * - Bare-`/` override → landing seed; the caller has already cleared any
 *   remembered stack (see `createPersistentMemoryHistory`).
 * - Override with nothing stored → seed the override alone (fresh window).
 * - Override equals the remembered current entry → keep the full remembered
 *   stack + cursor unchanged. This is the restored-launch common case: main
 *   derives the initial route FROM the same snapshot the stack was persisted
 *   under, so the two agree and the deep back-history survives. (Bug fix: the
 *   old code reset to `[override], index 0`, collapsing the stack on every cold
 *   restore because the sessionStorage consumed-marker never survives a quit.)
 * - Override differs from the remembered current entry → treat it like a fresh
 *   navigation: drop forward entries beyond the cursor, append the override,
 *   and point the cursor at it. Back history up to the previous current entry
 *   survives.
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
 * Creates a router history seeded from the explicit `initialRoute` override
 * merged into this window's `localStorage` history, or from that history alone
 * when the shell provides no route. Intended for the Electron renderer only -
 * the browser web app should use TanStack's default browser history.
 */
export function createPersistentMemoryHistory(
  initialRoute: string | null,
  windowId: string | null,
): PersistentRouterHistory {
  const persisted = loadPersistedState(windowId);
  const shellOverride = consumeShellOverride(initialRoute, windowId);
  if (shellOverride === "/") {
    // A bare-`/` shell override is the deliberate "start at the landing" signal:
    // the zero-restorable-windows cold start and the auth-fallback redirect both
    // funnel through it. Discard the remembered stack rather than merging - the
    // landing is meant to be a clean start, not the tail of a deep back-history
    // to routes the snapshot no longer references. `persistState` already refuses
    // to write a `/` current entry, so the immediate persist below leaves
    // localStorage cleared.
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

  // Controller-only subscriber store. Poked by the navigation callbacks below
  // and by `prune`, so navigability recomputes without ever calling
  // `history.notify()` (which would drive `router.load()`).
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
      entries.push(path);
      states.push(state);
      index = entries.length - 1;
      // Cap at the point of growth: the cursor is the tail here, so the
      // front-drop can never remove the current entry.
      index = capStackInPlace(entries, states, index);
      // Re-stamp unconditionally: TanStack derives the pushed `__TSR_index` from
      // its CACHED `location`, which a prior load-free `prune` (it never calls
      // `history.notify()`) may have left stale. Re-stamping keeps the stack's
      // `__TSR_index` contiguous regardless of that cache.
      restampIndices(states);
      persistState(windowId, entries, index);
      notifyController();
    },
    replaceState: (path: string, state: ParsedHistoryState) => {
      entries[index] = path;
      states[index] = state;
      // Collapse an adjacent byte-identical entry created by an in-place
      // replace. Two identical adjacent entries are always a dead back step
      // (`go(-1)` moves the cursor but not the rendered href), so dropping the
      // redundant current entry and stepping the cursor back onto its identical
      // neighbour is correct for ANY replace - this is a general
      // adjacent-duplicate guard, not overlay-specific. (Its common producer is
      // the settings/history overlay, whose entry is pushed onto the same path
      // and differs only by a search-param flag that this `replace` then clears.)
      if (index > 0 && entries[index - 1] === path) {
        entries.splice(index, 1);
        states.splice(index, 1);
        index -= 1;
        restampIndices(states);
      }
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
    getIndex: () => index,
    canGoBack: () => index > 0,
    canGoForward: () => index < entries.length - 1,
    prune: (isDead) => {
      // Keep the current entry unconditionally; drop any other entry the caller
      // proves dead. `survivors` carries the original state + a current marker
      // so the index can be remapped after filtering.
      const survivors = entries
        .map((href, i) => ({ href, state: states[i], wasCurrent: i === index }))
        .filter((entry) => entry.wasCurrent || !isDead(entry.href));

      // Current is never pruned, so a same-length result means nothing changed.
      if (survivors.length === entries.length) return false;

      const nextIndex = survivors.findIndex((entry) => entry.wasCurrent);
      // Mutate the closed-over arrays in place so `getLocation` keeps reading the
      // same references the history was created with, then re-stamp `__TSR_index`
      // contiguously so the next real `go(n)` lands on a location whose `state`
      // index matches its array position.
      entries.splice(
        0,
        entries.length,
        ...survivors.map((entry) => entry.href),
      );
      states.splice(0, states.length, ...survivors.map((entry) => entry.state));
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
  // Make the brand non-enumerable / non-writable / non-configurable: a shallow
  // clone (`{ ...history }`) must NOT copy it (a copy would carry a controller
  // bound to THIS closure's `entries`/`states`, diverging from the clone's own
  // navigation), and it can't be clobbered. `in` (used by `getHistoryController`)
  // still finds non-enumerable keys, so the guard is unaffected.
  Object.defineProperty(branded, PERSISTENT_HISTORY_CONTROLLER, {
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return branded;
}
