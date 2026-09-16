import { altSpokenLabel, modSpokenLabel } from "@/lib/keybindings/platform";

/** 0-based index -> displayed shortcut number. */
export function leaderDigitFor(index: number): string {
  return String(index + 1);
}

/**
 * Screen-reader label for a leader-digit shortcut hint. Takes the already
 * -computed digit (via `leaderDigitFor` or the wraparound
 * `singleDigitLeaderDigitFor`) rather than an index, so it stays correct for
 * whichever convention the caller's scope dispatches under.
 * The modifier is named even for digit-only visuals: a sibling scope can
 * reveal its hints while a different modifier is held.
 */
export function leaderHint(
  digit: string,
  modifier: "mod" | "alt",
  action: string,
  target: string,
): string {
  const name = modifier === "mod" ? modSpokenLabel() : altSpokenLabel();
  return `Press ${name}+${digit} ${action} ${target}`;
}
