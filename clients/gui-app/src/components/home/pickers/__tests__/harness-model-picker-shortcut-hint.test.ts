import { describe, expect, it } from "vitest";
import { formatModifierChordForDisplay } from "@/lib/keybindings/chord";
import { singleDigitLeaderDigitFor } from "@/providers/keybinding-context";
import { pickerProfileShortcutHintForIndex } from "../harness-model-picker-shortcut-hint";

describe("pickerProfileShortcutHintForIndex", () => {
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
});
