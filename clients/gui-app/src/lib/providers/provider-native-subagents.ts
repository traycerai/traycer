import type { SchemaVersion } from "@traycer/protocol/framework/index";

const PROVIDERS_LIST_NATIVE_SUBAGENTS_MAJOR = 10;
const PROVIDERS_LIST_NATIVE_SUBAGENTS_MINOR = 5;

/**
 * The `providers.list` line that PUBLISHES `nativeSubagents`: `10.5`. The major
 * is pinned rather than compared with `>`, like every other version predicate
 * in the tree; an `11.x` will need its own line. `null` - no handshake yet -
 * reads as not reporting.
 */
export function providersListReportsNativeSubagents(
  version: SchemaVersion | null,
): boolean {
  if (version === null) return false;
  return (
    version.major === PROVIDERS_LIST_NATIVE_SUBAGENTS_MAJOR &&
    version.minor >= PROVIDERS_LIST_NATIVE_SUBAGENTS_MINOR
  );
}
