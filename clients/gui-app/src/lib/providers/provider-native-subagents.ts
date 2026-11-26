import type { SchemaVersion } from "@traycer/protocol/framework/index";

const PROVIDERS_LIST_NATIVE_SUBAGENTS_MAJOR = 10;
const PROVIDERS_LIST_NATIVE_SUBAGENTS_MINOR = 5;
/**
 * `providers.list@11` is the `10.10` row over a wider provider id set (Cline)
 * and nothing else, so every minor of it publishes `nativeSubagents`.
 */
const PROVIDERS_LIST_WIDER_ID_SET_MAJOR = 11;

/**
 * The `providers.list` line that PUBLISHES `nativeSubagents`: `10.5` and every
 * minor of `11.x`. The major is pinned rather than compared with `>`, like
 * every other version predicate in the tree; a `12.x` will need its own line.
 * `null` - no handshake yet - reads as not reporting.
 */
export function providersListReportsNativeSubagents(
  version: SchemaVersion | null,
): boolean {
  if (version === null) return false;
  if (version.major === PROVIDERS_LIST_WIDER_ID_SET_MAJOR) return true;
  return (
    version.major === PROVIDERS_LIST_NATIVE_SUBAGENTS_MAJOR &&
    version.minor >= PROVIDERS_LIST_NATIVE_SUBAGENTS_MINOR
  );
}
