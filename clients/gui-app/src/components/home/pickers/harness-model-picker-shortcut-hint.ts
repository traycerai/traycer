import type { ProfileDropdownShortcutHint } from "@/components/providers/profile-dropdown";
import { formatModifierChordForDisplay } from "@/lib/keybindings/chord";
import { shortcutHintsVisible } from "@/lib/keybindings/shortcut-hints";
import {
  SINGLE_DIGIT_LEADER_INDEX_LIMIT,
  singleDigitLeaderDigitFor,
} from "@/providers/keybinding-context";

// The picker shows each row's ⌘⇧-digit shortcut - it's live-dispatchable
// there (`usePickerLeaderScope`'s `model.profile.byDigit`). Settings has no
// such wiring, so it injects a function that always returns `null` instead
// (see `provider-profile-scoped-section.tsx`) rather than a boolean the
// dropdown itself would have to branch on.
export function pickerProfileShortcutHintForIndex(
  index: number,
): ProfileDropdownShortcutHint | null {
  // Gated at the source rather than in the dropdown, which renders whatever
  // hint it is handed and owns no shortcut policy of its own.
  if (!shortcutHintsVisible()) return null;
  if (index >= SINGLE_DIGIT_LEADER_INDEX_LIMIT) return null;
  const digit = singleDigitLeaderDigitFor(index);
  return { digit, label: formatModifierChordForDisplay("mod+shift", digit) };
}
