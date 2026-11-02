import {
  normalizeCode,
  parseChordString,
  type ChordString,
} from "@traycer-clients/shared/keybindings/chord-core";
import { streamedBrowserChordsFor } from "@/lib/browser-view/reserved-chords-registration";
import { effectiveBinding, type ActionId } from "@/lib/keybindings/actions";

/**
 * One app chord a sandboxed page must not keep. The frame's bootstrap
 * matches keydowns against these physically (`KeyboardEvent.code` plus exact
 * modifiers), swallows a match and forwards it; every other key is the page's.
 */
export interface ForwardedShortcut {
  readonly code: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Every `KeyboardEvent.code` a chord key can come from. `normalizeCode` stays
 * the one definition of code → key; this list only enumerates its domain so
 * the mapping can be read backwards.
 */
const CANDIDATE_CODES: readonly string[] = [
  ...[...LETTERS].map((letter) => `Key${letter}`),
  ...[..."0123456789"].map((digit) => `Digit${digit}`),
  "Comma",
  "Period",
  "Slash",
  "Semicolon",
  "Quote",
  "Backquote",
  "Minus",
  "Equal",
  "BracketLeft",
  "BracketRight",
  "Backslash",
  "Space",
  "Enter",
  "Escape",
  "Tab",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
];

function codeForKey(key: string): string | null {
  return CANDIDATE_CODES.find((code) => normalizeCode(code) === key) ?? null;
}

/**
 * Close tab is forwarded on top of the shared rows. A browser tile keeps ⌘W
 * because it has a tab of its own to close; a sandboxed page has none, so a
 * ⌘W it keeps reaches nothing. Forwarding it closes the tile holding the
 * page, as ⌘W does with focus anywhere else in the canvas.
 */
const PAGE_FORWARDED_ACTIONS: readonly ActionId[] = ["tab.close"];

/**
 * The chords a page forwards: the APP-FORWARDED rows a focused browser tile
 * replays (palette, tab and task navigation) plus {@link PAGE_FORWARDED_ACTIONS},
 * resolved from the reader's live bindings. The other browser-scoped rows
 * (⌘T/⌘L) are a browser's, not a page's, so a page keeps them. `mod` is ⌘ on
 * macOS and Control elsewhere.
 */
export function sandboxForwardedShortcuts(
  bindings: Readonly<Record<ActionId, ChordString | null>>,
  mac: boolean,
): readonly ForwardedShortcut[] {
  const tokens = [
    ...streamedBrowserChordsFor(bindings, { landingSurfaceActive: false })
      .filter((row) => row.command === null)
      .map((row) => row.token),
    ...PAGE_FORWARDED_ACTIONS.flatMap((action) => {
      const chord = effectiveBinding(bindings, action);
      return chord === null ? [] : [chord];
    }),
  ];
  return tokens.flatMap((token): ForwardedShortcut[] => {
    const parts = parseChordString(token);
    if (parts === null) return [];
    const code = codeForKey(parts.key);
    if (code === null) return [];
    return [
      {
        code,
        ctrl: parts.ctrl || (parts.mod && !mac),
        meta: parts.mod && mac,
        alt: parts.alt,
        shift: parts.shift,
      },
    ];
  });
}

export function isForwardedShortcut(
  shortcuts: readonly ForwardedShortcut[],
  pressed: ForwardedShortcut,
): boolean {
  return shortcuts.some(
    (shortcut) =>
      shortcut.code === pressed.code &&
      shortcut.ctrl === pressed.ctrl &&
      shortcut.meta === pressed.meta &&
      shortcut.alt === pressed.alt &&
      shortcut.shift === pressed.shift,
  );
}
