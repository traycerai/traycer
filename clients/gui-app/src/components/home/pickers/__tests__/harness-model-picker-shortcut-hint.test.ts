import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlatformMock } from "@/__tests__/create-platform-mock";

const platformMock = vi.hoisted(() => ({ mac: false }));

vi.mock("@/lib/keybindings/platform", () => createPlatformMock(platformMock));

import { formatModifierChordForDisplay } from "@/lib/keybindings/chord";
import { singleDigitLeaderDigitFor } from "@/providers/keybinding-context";
import { setMobileApp } from "@/lib/mobile-app";
import {
  pickerLeaderControlLabel,
  pickerProfileShortcutHintForIndex,
} from "../harness-model-picker-shortcut-hint";

describe("pickerProfileShortcutHintForIndex", () => {
  afterEach(() => {
    setMobileApp(false);
  });

  it("shows a ⌘⇧-digit shortcut hint per row, matching the shared platform helper", () => {
    expect(pickerProfileShortcutHintForIndex(0)).toEqual({
      digit: singleDigitLeaderDigitFor(0),
      label: formatModifierChordForDisplay(
        "mod+shift",
        singleDigitLeaderDigitFor(0),
      ),
    });
    expect(pickerProfileShortcutHintForIndex(1)).toEqual({
      digit: singleDigitLeaderDigitFor(1),
      label: formatModifierChordForDisplay(
        "mod+shift",
        singleDigitLeaderDigitFor(1),
      ),
    });
  });

  it("caps hints at the shared single-digit limit - beyond-range indexes get no hint", () => {
    expect(pickerProfileShortcutHintForIndex(10)).toBeNull();
  });

  it("advertises the typable chord for every index - 0-8 show 1-9, index 9 shows 0", () => {
    for (let index = 0; index < 9; index += 1) {
      expect(pickerProfileShortcutHintForIndex(index)?.digit).toBe(
        String(index + 1),
      );
    }
    // Index 9 - the 10th row - dispatches on physical "0"
    // (`model.profile.byDigit` maps `digit === 0 ? 9 : digit - 1`), so its
    // hint must advertise "0", not the untypable "10".
    expect(pickerProfileShortcutHintForIndex(9)?.digit).toBe("0");
  });

  it("returns null on the installed mobile app regardless of index", () => {
    setMobileApp(true);
    expect(pickerProfileShortcutHintForIndex(0)).toBeNull();
  });
});

// Parent-control accessible name: CodeRabbit flagged the badge's own
// `aria-label` as unreachable through a parent that already owns an
// accessible name, so the spoken hint now lives on the CONTROL's label via
// this helper instead of on the badge (`harness-model-picker-leader-badge.tsx`
// renders `aria-hidden`).
describe("pickerLeaderControlLabel", () => {
  beforeEach(() => {
    platformMock.mac = false;
  });

  it("leaves the label unchanged when the modifier is null - leader not held or control gated", () => {
    expect(pickerLeaderControlLabel("Codex", 0, null, "to switch")).toBe(
      "Codex",
    );
  });

  it("appends the spoken mod hint off macOS - Control", () => {
    expect(pickerLeaderControlLabel("Codex", 0, "mod", "to switch")).toBe(
      "Codex. Press Control+1 to switch Codex",
    );
  });

  it("appends the spoken mod hint on macOS - Command", () => {
    platformMock.mac = true;
    expect(pickerLeaderControlLabel("Codex", 0, "mod", "to switch")).toBe(
      "Codex. Press Command+1 to switch Codex",
    );
  });

  it("appends the spoken alt hint off macOS - Alt", () => {
    expect(pickerLeaderControlLabel("Low", 0, "alt", "to set")).toBe(
      "Low. Press Alt+1 to set Low",
    );
  });

  it("appends the spoken alt hint on macOS - Option", () => {
    platformMock.mac = true;
    expect(pickerLeaderControlLabel("Fast mode", 9, "alt", "to toggle")).toBe(
      "Fast mode. Press Option+0 to toggle Fast mode",
    );
  });

  it("advertises the typable digit for the 10th slot (index 9) as 0, not 10", () => {
    expect(pickerLeaderControlLabel("Fast mode", 9, "mod", "to toggle")).toBe(
      "Fast mode. Press Control+0 to toggle Fast mode",
    );
  });
});
