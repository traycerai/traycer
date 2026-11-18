/**
 * Shared `DEV_DESKTOP_SLOT` env-var scoping helper for tests that exercise
 * dev-desktop-slot-aware path/label resolution. Temporarily sets the slot
 * for the duration of `fn`, then restores whatever value (or absence) was
 * there before - so tests never leak the override into a sibling test.
 */
import { DEV_DESKTOP_SLOT_ENV } from "../platform/dev-desktop-slot";

// Sets the slot and returns a restore callback - the one piece of state
// (previous value, present or not) both the sync and async variants below
// need to save/set/restore identically.
function setDevDesktopSlotEnv(slot: string): () => void {
  const previous = process.env[DEV_DESKTOP_SLOT_ENV];
  process.env[DEV_DESKTOP_SLOT_ENV] = slot;
  return () => {
    if (previous === undefined) {
      delete process.env[DEV_DESKTOP_SLOT_ENV];
    } else {
      process.env[DEV_DESKTOP_SLOT_ENV] = previous;
    }
  };
}

export function withDevDesktopSlot(slot: string, fn: () => void): void {
  const restore = setDevDesktopSlotEnv(slot);
  try {
    fn();
  } finally {
    restore();
  }
}

export async function withDevDesktopSlotAsync(
  slot: string,
  fn: () => Promise<void>,
): Promise<void> {
  const restore = setDevDesktopSlotEnv(slot);
  try {
    await fn();
  } finally {
    restore();
  }
}
