import { v4 as uuidv4 } from "uuid";

/**
 * Read a persisted tab `instanceId`, minting a fresh one when absent. `instanceId` is the per-tab
 * identity decoupled from the content `id`.
 */
export function readTileInstanceId(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : uuidv4();
}
