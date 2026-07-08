/**
 * Shared `DEV_DESKTOP_SLOT` env-var scoping helper for tests that exercise
 * dev-desktop-slot-aware path/label resolution. Temporarily sets the slot
 * for the duration of `fn`, then restores whatever value (or absence) was
 * there before - so tests never leak the override into a sibling test.
 */
import { DEV_DESKTOP_SLOT_ENV } from "../platform/dev-desktop-slot";

export function withDevDesktopSlot(slot: string, fn: () => void): void {
  const previous = process.env[DEV_DESKTOP_SLOT_ENV];
  process.env[DEV_DESKTOP_SLOT_ENV] = slot;
  try {
    fn();
  } finally {
    if (previous === undefined) {
      delete process.env[DEV_DESKTOP_SLOT_ENV];
    } else {
      process.env[DEV_DESKTOP_SLOT_ENV] = previous;
    }
  }
}

export async function withDevDesktopSlotAsync(
  slot: string,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = process.env[DEV_DESKTOP_SLOT_ENV];
  process.env[DEV_DESKTOP_SLOT_ENV] = slot;
  try {
    await fn();
  } finally {
    if (previous === undefined) {
      delete process.env[DEV_DESKTOP_SLOT_ENV];
    } else {
      process.env[DEV_DESKTOP_SLOT_ENV] = previous;
    }
  }
}
