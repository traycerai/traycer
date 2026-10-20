import type { SchemaVersion } from "@traycer/protocol/framework/index";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";

/**
 * Whether this provider's agents may start the provider's own built-in
 * subagents, as the host has it stored.
 *
 * The one read seam for the value, for the reason `providerAutoJudgeFor` gives
 * for its own: `ProviderCliState.nativeSubagents` is `.optional()` on the wire
 * rather than defaulted, so absent stays distinguishable from a stored value at
 * the protocol boundary, and the fallback is spelled once, here. `true` - the
 * provider's tooling as shipped - is the answer both for "nothing was ever
 * chosen" and for a host too old to have the notion.
 */
export function providerNativeSubagentsFor(state: ProviderCliState): boolean {
  return state.nativeSubagents ?? true;
}

/**
 * The `providers.list` line that PUBLISHES `nativeSubagents`: `10.5`. The major
 * is pinned rather than compared with `>`, like every other version predicate
 * in the tree; an `11.x` will need its own line. `null` - no handshake yet -
 * reads as not reporting.
 */
const PROVIDERS_LIST_NATIVE_SUBAGENTS_MAJOR = 10;
const PROVIDERS_LIST_NATIVE_SUBAGENTS_MINOR = 5;

export function providersListReportsNativeSubagents(
  version: SchemaVersion | null,
): boolean {
  if (version === null) return false;
  return (
    version.major === PROVIDERS_LIST_NATIVE_SUBAGENTS_MAJOR &&
    version.minor >= PROVIDERS_LIST_NATIVE_SUBAGENTS_MINOR
  );
}
