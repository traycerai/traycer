import type { SchemaVersion } from "@traycer/protocol/framework/index";

/**
 * The `host.usage.summary` MAJOR whose request carries
 * `plane: "local-only"` - the selector that reaches the local reader without
 * the cloud round trip that otherwise gates it.
 *
 * A major rather than a minor, and not by choice: `@1.0`'s request schema is
 * `.strict()`, so an older peer REJECTS an unknown key outright instead of
 * stripping it, and the protocol's additivity gate refuses the growth within
 * the line. See the contract in `host/usage-analytics/contracts.ts`.
 */
export const USAGE_SUMMARY_LOCAL_ONLY_MAJOR = 2;

/**
 * Whether this host can be asked for the local usage reader directly.
 *
 * The consequence of getting this wrong is unusually sharp, and it is why the
 * predicate exists rather than the call site testing a version inline. Every
 * other selector in this program rides a lenient schema, so sending it to an
 * old host is harmless - the key is dropped and the released behaviour runs.
 * Here the old host's request schema is `.strict()`, so the whole request is
 * REJECTED: send `plane` to a `@1.0` peer and the usage panel fails outright
 * rather than degrading. The negotiated-version gate is the mechanism, not a
 * second belt on one.
 *
 * FAILS CLOSED on both non-version answers - `false` (handshook, method
 * absent) and `null` (unknown). Refusing strands nothing: the manifest
 * arriving re-renders the reader and the panel resolves.
 */
export function negotiatedUsageServesLocalOnly(
  version: SchemaVersion | null | false,
): boolean {
  if (version === null || version === false) return false;
  return version.major >= USAGE_SUMMARY_LOCAL_ONLY_MAJOR;
}
