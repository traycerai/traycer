/** `@traycer/protocol` - the single home for traycer 3.0 message schemas. */

export * from "./framework/index";
export { authRecordRegistry } from "./auth/registry";
export type { AuthRecordRegistry } from "./auth/registry";
export { commonRecordRegistry } from "./common/registry";
export type { CommonRecordRegistry } from "./common/registry";
export {
  persistenceRecordRegistry,
  epicRecordV200,
  epicRecordV300,
  roomMetadataRecordV100,
} from "./persistence/registry";
export type { PersistenceRecordRegistry } from "./persistence/registry";
