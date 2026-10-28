import type * as Y from "yjs";
import {
  BROWSER_CATALOG_HEAD_WAKE_FUTURE_SKEW_MS,
  BROWSER_CATALOG_HEAD_WAKE_STALE_TTL_MS,
} from "@traycer/protocol/host/browser/catalog-head-wake-room";
import { SIMULATOR_CATALOG_HEAD_WAKE_MAP_KEY } from "@traycer/protocol/host/simulator/catalog-contracts";

/**
 * The newest fresh head version any host wrote for `epicId` into the
 * simulator catalog's wake map. The host's writer is the browser catalog's,
 * pointed at {@link SIMULATOR_CATALOG_HEAD_WAKE_MAP_KEY}, so an entry has the
 * browser shape and the same freshness window. A version is an invalidation
 * hint only: the periodic read repairs a missed one.
 */
export function readSimulatorCatalogHeadWakeVersion(
  doc: Y.Doc,
  epicId: string,
  now: number,
): number | null {
  let version: number | null = null;
  for (const value of doc
    .getMap<unknown>(SIMULATOR_CATALOG_HEAD_WAKE_MAP_KEY)
    .values()) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      continue;
    const entry: Record<string, unknown> = { ...value };
    if (
      entry.epicId !== epicId ||
      typeof entry.version !== "number" ||
      !Number.isSafeInteger(entry.version) ||
      typeof entry.updatedAt !== "number" ||
      entry.updatedAt < now - BROWSER_CATALOG_HEAD_WAKE_STALE_TTL_MS ||
      entry.updatedAt > now + BROWSER_CATALOG_HEAD_WAKE_FUTURE_SKEW_MS
    )
      continue;
    version =
      version === null ? entry.version : Math.max(version, entry.version);
  }
  return version;
}
