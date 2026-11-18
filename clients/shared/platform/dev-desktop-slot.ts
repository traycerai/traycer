// Canonical `make dev-desktop` multi-run slot helpers, shared so the CLI
// (`clients/traycer-cli/src/store/dev-desktop-slot.ts`) and Desktop
// (`clients/desktop/src/electron-main/host/dev-desktop-slot.ts`) can never
// diverge on how a slot name is sanitized - both sides must resolve the
// exact same install/runtime paths and service label for a given
// `DEV_DESKTOP_SLOT` value. `scripts/dev-desktop.js` (plain Node, outside
// this Bun workspace) keeps its own `sanitizeSlotId` copy in lockstep by
// convention; its test suite asserts the same behavior.
export const DEV_DESKTOP_SLOT_ENV = "DEV_DESKTOP_SLOT";

export function sanitizeDevDesktopSlot(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

// OAuth deep-link scheme for a dev-desktop run. Every slot registering the
// bare dev scheme (`traycer-dev://`) would make the OS route auth-callback
// deep links to whichever run registered last, so each slot suffixes its
// scheme (`traycer-dev-<slot>://`). The sanitized slot alphabet ([a-z0-9-])
// is a valid URI-scheme suffix by construction (RFC 3986: ALPHA *( ALPHA /
// DIGIT / "+" / "-" / "." )). `null` (no slot) keeps the base scheme.
export function devDesktopSlotProtocolScheme(
  baseScheme: string,
  slot: string | null,
): string {
  if (slot === null) return baseScheme;
  return `${baseScheme}-${slot}`;
}

// `environment` is typed as `string` here (rather than each client's own
// `Environment` alias) so this module has no dependency on either client's
// config - both aliases resolve to `string` today, so passing either
// through type-checks unchanged.
export function devDesktopSlotForEnvironment(
  environment: string,
  env: NodeJS.ProcessEnv,
): string | null {
  if (environment !== "dev") return null;
  const raw = env[DEV_DESKTOP_SLOT_ENV];
  if (typeof raw !== "string") return null;
  const slot = sanitizeDevDesktopSlot(raw);
  if (slot.length === 0) {
    throw new Error(`${DEV_DESKTOP_SLOT_ENV} must contain a usable slot name`);
  }
  return slot;
}
