import { v4 as uuidv4 } from "uuid";

/**
 * Read a persisted tab `instanceId`, minting a fresh one when absent.
 *
 * `instanceId` is the per-tab identity decoupled from the content `id`.
 * Tiles persisted before the decoupling carry no `instanceId`; there is
 * no migration (app unreleased), so a stale tile simply receives a new
 * tab identity on rehydrate. The group's `activeTabId` / `previewTabId`
 * fall back to the first tab when their persisted (content-id) value no
 * longer matches any freshly-minted `instanceId`.
 */
export function readTileInstanceId(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : uuidv4();
}
