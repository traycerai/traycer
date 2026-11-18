import type { SchemaVersion } from "@traycer/protocol/framework/index";

const PROVIDERS_LIST_NATIVE_MEMORY_MAJOR = 10;
const PROVIDERS_LIST_NATIVE_MEMORY_MINOR = 8;

/**
 * The `providers.list` line that PUBLISHES the native-memory pair: `10.8`. The
 * major is pinned rather than compared with `>`, like every other version
 * predicate in the tree; an `11.x` will need its own line. `null` - no
 * handshake yet - reads as not reporting.
 */
export function providersListReportsNativeMemory(
  version: SchemaVersion | null,
): boolean {
  if (version === null) return false;
  return (
    version.major === PROVIDERS_LIST_NATIVE_MEMORY_MAJOR &&
    version.minor >= PROVIDERS_LIST_NATIVE_MEMORY_MINOR
  );
}
