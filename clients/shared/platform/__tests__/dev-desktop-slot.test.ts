import { describe, expect, it } from "vitest";
import {
  DEV_DESKTOP_SLOT_ENV,
  devDesktopSlotForEnvironment,
  devDesktopSlotProtocolScheme,
  sanitizeDevDesktopSlot,
} from "../dev-desktop-slot";

// Canonical vectors for the CLI, Desktop, and `scripts/dev-desktop.js` slot
// sanitizers, which must all agree byte-for-byte on how a slot name is
// normalized - a mismatch means the CLI and Desktop resolve different
// install/runtime paths for what a developer thinks is one run.
export const SLOT_SANITIZE_VECTORS: ReadonlyArray<
  readonly [raw: string, expected: string]
> = [
  [" My Slot!! ", "my-slot"],
  ["Traycer Internal Worktree", "traycer-internal-worktree"],
  ["a___b", "a-b"],
  ["-leading-and-trailing-", "leading-and-trailing"],
  ["a".repeat(80), "a".repeat(64)],
];

describe("sanitizeDevDesktopSlot", () => {
  it.each(SLOT_SANITIZE_VECTORS)("normalizes %j to %j", (raw, expected) => {
    expect(sanitizeDevDesktopSlot(raw)).toBe(expected);
  });
});

describe("devDesktopSlotForEnvironment", () => {
  it("returns null outside the dev environment regardless of the env var", () => {
    expect(
      devDesktopSlotForEnvironment("production", {
        [DEV_DESKTOP_SLOT_ENV]: "some-slot",
      }),
    ).toBeNull();
    expect(
      devDesktopSlotForEnvironment("staging", {
        [DEV_DESKTOP_SLOT_ENV]: "some-slot",
      }),
    ).toBeNull();
  });

  it("returns null in dev when the slot env is unset", () => {
    expect(devDesktopSlotForEnvironment("dev", {})).toBeNull();
  });

  it("returns the sanitized slot in dev when the env var is set", () => {
    expect(
      devDesktopSlotForEnvironment("dev", {
        [DEV_DESKTOP_SLOT_ENV]: "My Worktree",
      }),
    ).toBe("my-worktree");
  });

  it("throws when the slot env sanitizes to empty", () => {
    expect(() =>
      devDesktopSlotForEnvironment("dev", { [DEV_DESKTOP_SLOT_ENV]: "   " }),
    ).toThrow(/must contain a usable slot name/);
  });
});

describe("devDesktopSlotProtocolScheme", () => {
  it("keeps the base scheme when no slot is active", () => {
    expect(devDesktopSlotProtocolScheme("traycer-dev", null)).toBe(
      "traycer-dev",
    );
  });

  it("suffixes the base scheme with the slot", () => {
    expect(devDesktopSlotProtocolScheme("traycer-dev", "my-worktree")).toBe(
      "traycer-dev-my-worktree",
    );
  });

  it.each(SLOT_SANITIZE_VECTORS)(
    "produces a valid URI scheme for sanitize vector %j",
    (raw) => {
      const scheme = devDesktopSlotProtocolScheme(
        "traycer-dev",
        sanitizeDevDesktopSlot(raw),
      );
      expect(scheme).toMatch(/^[a-z][a-z0-9+\-.]*$/);
    },
  );
});
