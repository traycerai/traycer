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

function loadPersistedState(windowId: string | null): PersistedState {
  if (typeof window === "undefined") return { entries: ["/"], index: 0 };
  if (windowId === null) return { entries: ["/"], index: 0 };
  const storageKey = buildStorageKey(windowId);
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw === null) return { entries: ["/"], index: 0 };
    const parsed: unknown = JSON.parse(raw);
    if (!isPersistedState(parsed)) {
      appLogger.warn("[history] persisted route state rejected", {
        windowId,
      });
      removePersistedState(storageKey);
      return { entries: ["/"], index: 0 };
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
    return { entries: ["/"], index: 0 };
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
    const capped =
      entries.length > MAX_ENTRIES
        ? entries.slice(entries.length - MAX_ENTRIES)
        : entries;
    const cappedIndex =
      entries.length > MAX_ENTRIES
        ? Math.max(0, index - (entries.length - MAX_ENTRIES))
        : index;
    window.localStorage.setItem(
      buildStorageKey(windowId),
      JSON.stringify({ entries: capped, index: cappedIndex }),
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
 * Creates a router history seeded from the explicit `initialRoute` override,
 * or from this window's `localStorage` history when the shell provides no
 * route. Intended for the Electron renderer only - the browser web app should
 * use TanStack's default browser history.
 */
export function createPersistentMemoryHistory(
  initialRoute: string | null,
  windowId: string | null,
): RouterHistory {
  const persisted = loadPersistedState(windowId);
  const shellOverride = consumeShellOverride(initialRoute, windowId);
  if (shellOverride === "/") {
    clearPersistedState(windowId);
  }

  const entries: string[] =
    shellOverride !== null ? [shellOverride] : [...persisted.entries];
  const states: LocationState[] = entries.map((_entry, i) =>
    makeInitialState(i),
  );
  let index = shellOverride !== null ? 0 : persisted.index;

  let blockers: Parameters<
    NonNullable<Parameters<typeof createHistory>[0]["setBlockers"]>
  >[0] = [];

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
      persistState(windowId, entries, index);
    },
    replaceState: (path: string, state: ParsedHistoryState) => {
      entries[index] = path;
      states[index] = state;
      persistState(windowId, entries, index);
    },
    back: () => {
      index = Math.max(index - 1, 0);
      persistState(windowId, entries, index);
    },
    forward: () => {
      index = Math.min(index + 1, entries.length - 1);
      persistState(windowId, entries, index);
    },
    go: (n) => {
      index = Math.min(Math.max(index + n, 0), entries.length - 1);
      persistState(windowId, entries, index);
    },
    createHref: (path) => path,
    getBlockers: () => blockers,
    setBlockers: (newBlockers) => {
      blockers = newBlockers;
    },
  });

  return history;
}
