/**
 * `@traycer/protocol` - the single home for traycer 3.0 message schemas.
 *
 * The split is strict:
 *
 * - `framework/` holds the active runtime: versioned contract builders,
 *   validators, upgrade/downgrade traversal. These modules carry logic.
 * - `host/`, `persistence/`, and the Traycer cloud message groups hold
 *   inert Zod message definitions, grouped by the system that owns the wire
 *   or storage boundary. These modules only declare registries; no runtime
 *   branching or transport code lives there.
 *
 * Per-domain record registries (auth, common, persistence) are
 * re-exported from here. Raw schema modules under each domain's
 * `_internal/` are private - consumers should obtain runtime schemas
 * via `getRecordSchema(<registry>, "<record-name>")`.
 */

export * from "./framework/index";
export { authRecordRegistry } from "./auth/registry";
export type { AuthRecordRegistry } from "./auth/registry";
export { commonRecordRegistry } from "./common/registry";
export type { CommonRecordRegistry } from "./common/registry";
export {
  persistenceRecordRegistry,
  epicRecordV200,
  roomMetadataRecordV100,
} from "./persistence/registry";
export type { PersistenceRecordRegistry } from "./persistence/registry";
