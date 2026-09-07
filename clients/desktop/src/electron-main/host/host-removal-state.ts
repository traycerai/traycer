import { app } from "electron";
import { join } from "node:path";
import type { HostRemovalState } from "../../ipc-contracts/host-management-types";
import {
  createJsonFileStore,
  type JsonFileStore,
} from "../app/json-file-store";
import { log } from "../app/logger";

const DEFAULT_STATE: HostRemovalState = { removedByUser: false };

let store: JsonFileStore<HostRemovalState> | null = null;
let cached: HostRemovalState | null = null;
let loadInFlight: Promise<HostRemovalState> | null = null;

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
 * Reads the cached value after the first load; the cache is kept in lockstep with `mark` / `clear` below so a synchronous-feeling read after a mutation always reflects it.
 * The initial load ADOPTS ONCE and never overwrites.
 */
export async function isHostRemovedByUser(): Promise<boolean> {
  if (cached === null) {
    if (loadInFlight === null) {
      loadInFlight = getStore().load();
    }
    const loaded = await loadInFlight;
    loadInFlight = null;
    if (cached === null) {
      cached = loaded;
    }
  }
  return cached.removedByUser;
}

/** Mark the device as removed-by-user and persist it. */
export async function markHostRemovedByUser(): Promise<void> {
  const store = getStore();
  const next: HostRemovalState = { removedByUser: true };
  await store.save(next);
  await store.flush();
  // Only adopt the in-memory cache once the write is confirmed, so it never diverges from disk.
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

export function __resetHostRemovalStateForTest(): void {
  store = null;
  cached = null;
  loadInFlight = null;
}
