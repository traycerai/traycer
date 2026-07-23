import { app } from "electron";
import { join } from "node:path";
import type { HostRemovalState } from "../../ipc-contracts/host-management-types";
import {
  createJsonFileStore,
  type JsonFileStore,
} from "../app/json-file-store";
import { log } from "../app/logger";

/**
 * Persistent "the user removed Traycer's background components" sentinel.
 *
 * Set by the in-app "Remove Traycer" action (Settings → General → Danger
 * Zone). While set, every auto-provision / respawn `HostController` intent
 * (`convergeReady`, `respawn`, `recoverIfDown`, the launch-time
 * `applyStaged` reconcile) short-circuits, so a removed host is never
 * silently reinstalled when it goes unreachable - which is exactly what the
 * app does today whenever the host goes down. Cleared by an explicit
 * reinstall.
 *
 * Lives under `userData` (a desktop-app-level decision), NOT under
 * `~/.traycer` - removal does not touch the user's data directory.
 */
const DEFAULT_STATE: HostRemovalState = { removedByUser: false };

let store: JsonFileStore<HostRemovalState> | null = null;
let cached: HostRemovalState | null = null;

function getStore(): JsonFileStore<HostRemovalState> {
  if (store === null) {
    const filePath = join(app.getPath("userData"), "host-removal-state.json");
    store = createJsonFileStore<HostRemovalState>(
      filePath,
      DEFAULT_STATE,
      parseRemovalState,
    );
  }
  return store;
}

function parseRemovalState(value: unknown): HostRemovalState {
  if (
    value !== null &&
    typeof value === "object" &&
    (value as { removedByUser?: unknown }).removedByUser === true
  ) {
    return { removedByUser: true };
  }
  return DEFAULT_STATE;
}

/**
 * Whether the user has removed Traycer's background components on this
 * device. Reads the cached value after the first load; the cache is kept in
 * lockstep with `mark` / `clear` below so a synchronous-feeling read after a
 * mutation always reflects it.
 */
export async function isHostRemovedByUser(): Promise<boolean> {
  if (cached === null) {
    cached = await getStore().load();
  }
  return cached.removedByUser;
}

/** Mark the device as removed-by-user and persist it. */
export async function markHostRemovedByUser(): Promise<void> {
  const store = getStore();
  const next: HostRemovalState = { removedByUser: true };
  await store.save(next);
  await store.flush();
  // `JsonFileStore.save` logs-and-swallows a write failure, so read the
  // sentinel back to confirm it actually reached disk. If it didn't, throw so
  // the uninstall fails loudly *before* the host is removed - removing the host
  // with a sentinel that won't survive a restart is exactly what would let the
  // app silently reinstall the host the user asked to remove. Only adopt the
  // in-memory cache once the write is confirmed, so it never diverges from disk.
  const persisted = await store.load();
  if (!persisted.removedByUser) {
    throw new Error("Failed to persist host removal state to disk");
  }
  cached = next;
  log.info("[host-removal] marked removed by user");
}

/** Clear the sentinel so the next ensure reinstalls the host. */
export async function clearHostRemovedByUser(): Promise<void> {
  cached = { removedByUser: false };
  await getStore().save(cached);
  log.info("[host-removal] cleared removed-by-user");
}

/**
 * Test-only: both the in-memory cache and the memoized store handle are
 * module-level and would otherwise leak across test cases that point
 * `app.getPath("userData")` at a fresh temp dir per test (e.g. a
 * `HostController` suite exercising `removeTraycer`/`uninstallHost` against
 * real on-disk state).
 */
export function __resetHostRemovalStateForTest(): void {
  store = null;
  cached = null;
}
