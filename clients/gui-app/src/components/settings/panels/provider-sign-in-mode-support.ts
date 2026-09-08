import type { SchemaVersion } from "@traycer/protocol/framework/index";

/**
 * Whether the negotiated `providers.startLogin` line carries `mode`/
 * `userCode` (D21/D22, `@1.2`). An older host negotiates `1.1` or earlier, and
 * the "Use a code instead" toggle must not render for it - the host's `1.1`
 * resolver has no `mode` field to read, so a click would silently no-op
 * instead of switching anything.
 *
 * One source of truth for this gate: every surface that offers the toggle
 * (the add-profile dialog, the Settings reauth panel, and by extension the
 * composer banner once it renders one) reads it from here rather than
 * re-deriving the version comparison per call site.
 */
export function signInModeToggleSupported(
  schemaVersion: SchemaVersion | null,
): boolean {
  if (schemaVersion === null) return false;
  // Fails closed on any major other than the one `@1.2` lives on: this method
  // has never bumped majors, and a future one is a different shape this
  // function has no business assuming carries `mode`.
  return schemaVersion.major === 1 && schemaVersion.minor >= 2;
}
