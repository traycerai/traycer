// `scripts/dev-desktop.js` (plain Node, outside this Bun workspace) keeps its own `sanitizeSlotId` copy in lockstep by convention; its test suite asserts the same behavior.
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

// OAuth deep-link scheme for a dev-desktop run.
export function devDesktopSlotProtocolScheme(
  baseScheme: string,
  slot: string | null,
): string {
  if (slot === null) return baseScheme;
  return `${baseScheme}-${slot}`;
}

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
