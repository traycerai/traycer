import { isMac } from "@/lib/keybindings/platform";

/** The fields read off a DOM or React keydown; both event types satisfy it. */
export interface ListNavigationKeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

const NEXT_ITEM_LETTERS: ReadonlySet<string> = new Set(["n", "j"]);
const PREVIOUS_ITEM_LETTERS: ReadonlySet<string> = new Set(["p", "k"]);

/**
 * The key a vertical list should act on: `event.key`, except that on macOS
 * Ctrl+N / Ctrl+J read as `ArrowDown` and Ctrl+P / Ctrl+K as `ArrowUp`.
 *
 * Mac users carry these from the system text bindings and from terminal tools,
 * and with a menu open they expect them to move the highlight rather than the
 * caret behind it. The aliases are macOS-only because that is the platform
 * convention (VS Code and Firefox scope them the same way): on Windows and
 * Linux Ctrl is the app modifier, Ctrl+N/J/K are app shortcuts here, and a
 * browser never hands Ctrl+N to a page at all.
 *
 * List handlers read this in place of `event.key`, so every list that answers
 * the arrow keys answers the aliases the same way.
 */
export function listNavigationKey(event: ListNavigationKeyEvent): string {
  if (
    !isMac() ||
    !event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey
  ) {
    return event.key;
  }
  const letter = event.key.toLowerCase();
  if (NEXT_ITEM_LETTERS.has(letter)) return "ArrowDown";
  if (PREVIOUS_ITEM_LETTERS.has(letter)) return "ArrowUp";
  return event.key;
}
