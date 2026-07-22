import {
  altLabel,
  ctrlLabel,
  isMac,
  modLabel,
  shiftLabel,
} from "@/lib/keybindings/platform";
import {
  formatChord,
  parseChordString,
  type ChordKey,
  type ChordParts,
  type ChordString,
} from "@traycer-clients/shared/keybindings/chord-core";

/**
 * Canonical chord string: `mod+ctrl+shift+alt+key` where modifiers appear in
 * this fixed order and only when active. `mod` is the platform-primary
 * modifier (Meta on Mac, Control elsewhere); `ctrl` is the Control key
 * SPECIFICALLY (distinct from `mod` on macOS, where Control ≠ Command). `key`
 * is the normalized physical key identifier (see `normalizeCode`).
 *
 * Examples: `mod+1`, `mod+shift+h`, `mod+alt+arrowleft`, `mod+,`, `ctrl+shift+m`.
 *
 * Note: `chordFromEvent` never emits `ctrl`. It treats `mod` as the
 * platform-primary modifier: Command on macOS, Command/Control elsewhere.
 * `ctrl` chords are matched by consumers that need a Control-specific binding
 * (e.g. the dictation hotkey).
 *
 * The parse/format core (`formatChord`/`parseChordString` and their types)
 * lives in `@traycer-clients/shared/keybindings/chord-core` - it has no
 * `navigator`/DOM dependency, so it's also importable from the Electron main
 * process (global-shortcut registration). Everything below that touches
 * `KeyboardEvent` or platform display labels stays here.
 */
export type { ChordKey, ChordParts, ChordString };
export { formatChord, parseChordString };

/** Physical keys we never want to treat as a primary chord key. */
const BARE_MODIFIER_CODES = new Set<string>([
  "MetaLeft",
  "MetaRight",
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
  "OSLeft",
  "OSRight",
]);

const CODE_TO_KEY: Readonly<Record<string, string>> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Space: "space",
  Enter: "enter",
  Escape: "escape",
  Tab: "tab",
  Backspace: "backspace",
  Delete: "delete",
  ArrowUp: "arrowup",
  ArrowDown: "arrowdown",
  ArrowLeft: "arrowleft",
  ArrowRight: "arrowright",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
};

/** Normalize `KeyboardEvent.code` to our canonical key token. */
export function normalizeCode(code: string): ChordKey | null {
  if (BARE_MODIFIER_CODES.has(code)) return null;
  if (code.startsWith("Key") && code.length === 4) {
    return code.slice(3).toLowerCase();
  }
  if (code.startsWith("Digit") && code.length === 6) {
    return code.slice(5);
  }
  if (code.startsWith("Numpad") && code.length === 7) {
    const tail = code.slice(6);
    if (/^\d$/.test(tail)) return tail;
  }
  if (Object.hasOwn(CODE_TO_KEY, code)) return CODE_TO_KEY[code];
  if (/^F\d{1,2}$/.test(code)) return code.toLowerCase();
  return null;
}

/** Detect whether a keydown is bare modifier (no other key). */
export function isBareModifierEvent(event: KeyboardEvent): boolean {
  return BARE_MODIFIER_CODES.has(event.code);
}

/** Cmd+Home/End on macOS, Ctrl+Home/End on Windows/Linux. */
export function isPlatformModifiedBoundaryKey(event: KeyboardEvent): boolean {
  return (
    (event.key === "Home" || event.key === "End") &&
    (isMac()
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey) &&
    !event.altKey &&
    !event.shiftKey
  );
}

/** Unmodified Home/End. */
export function isPlainBoundaryKey(event: KeyboardEvent): boolean {
  return (
    (event.key === "Home" || event.key === "End") &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  );
}

export function parseChordFromEvent(event: KeyboardEvent): ChordParts | null {
  if (isBareModifierEvent(event)) return null;
  const key = normalizeCode(event.code);
  if (key === null) return null;
  // `mod` follows the platform-primary modifier. On macOS that is Command only;
  // Control-specific chords use the ctrl-aware path below.
  const mod = hasPlatformModKey(event);
  const shift = event.shiftKey;
  const alt = event.altKey;
  return { mod, ctrl: false, shift, alt, key };
}

/**
 * Returns the canonical chord string if `event` encodes a complete chord
 * (not a bare modifier), otherwise null.
 */
export function chordFromEvent(event: KeyboardEvent): ChordString | null {
  const parts = parseChordFromEvent(event);
  if (parts === null) return null;
  return formatChord(parts);
}

/**
 * Like `parseChordFromEvent` but distinguishes the Control key from the
 * platform-primary modifier on macOS (where ⌃ ≠ ⌘): Command → `mod`,
 * Control → `ctrl`. Non-mac is unchanged (Control IS the primary, captured as
 * `mod`). Used by the chord-capture UI and the provider so a Control-specific
 * binding (e.g. dictation) can be authored and matched - Control is also the
 * only modifier macOS lets us detect on key-release, which push-to-talk needs.
 */
export function parseChordFromEventCtrlAware(
  event: KeyboardEvent,
): ChordParts | null {
  if (isBareModifierEvent(event)) return null;
  const key = normalizeCode(event.code);
  if (key === null) return null;
  const mac = isMac();
  const mod = hasPlatformModKey(event);
  const ctrl = mac && event.ctrlKey;
  const shift = event.shiftKey;
  const alt = event.altKey;
  return { mod, ctrl, shift, alt, key };
}

export function chordFromEventCtrlAware(
  event: KeyboardEvent,
): ChordString | null {
  const parts = parseChordFromEventCtrlAware(event);
  if (parts === null) return null;
  return formatChord(parts);
}

/**
 * The single chord an event should be matched against, applying the
 * ctrl-aware-vs-platform-primary precedence: when the Control-specific chord
 * (macOS ⌃, distinct from ⌘) differs from the platform-primary chord, the
 * event matches ONLY that ctrl chord - so a bare macOS Control chord can't fall
 * through to a plain key binding. Otherwise the platform-primary chord is used.
 * Centralizes this security-relevant contract for every consumer (event→action
 * matching in the provider, and `chordMatchesEvent`).
 */
export function resolveMatchingChord(event: KeyboardEvent): ChordString | null {
  const eventChord = chordFromEvent(event);
  const ctrlAwareChord = chordFromEventCtrlAware(event);
  if (ctrlAwareChord !== null && ctrlAwareChord !== eventChord) {
    return ctrlAwareChord;
  }
  return eventChord;
}

/** Does the event match the stored chord string exactly? */
export function chordMatchesEvent(
  chord: ChordString,
  event: KeyboardEvent,
): boolean {
  return resolveMatchingChord(event) === chord;
}

/** Human-friendly display label e.g. `⌘⇧H` / `Ctrl+Shift+H`. */
export function formatChordForDisplay(chord: ChordString): string {
  const parts = parseChordString(chord);
  if (parts === null) return chord;
  const segs: Array<string> = [];
  if (parts.mod) segs.push(modLabel());
  if (parts.ctrl) segs.push(ctrlLabel());
  if (parts.shift) segs.push(shiftLabel());
  if (parts.alt) segs.push(altLabel());
  segs.push(formatKeyForDisplay(parts.key));
  return isMac() ? segs.join("") : segs.join("+");
}

// ---------------------------------------------------------------------------
// Modifier-only chords - used by "digit" actions whose effective key is one
// of 0..9 at runtime (e.g. `epic.switch.byDigit` can compose multi-digit tab
// numbers from those keys). Stored as `mod`, `alt`, `mod+alt`, etc. (no key
// token).
//
// These intentionally support only `mod`/`shift`/`alt` - NOT the Control-
// specific `ctrl` token. Digit/leader actions are not rebindable to a chord in
// the Settings UI (they render read-only), so a `ctrl` leader can't be authored;
// `parseModifierChord` returning null for a `ctrl` token is the correct
// "unsupported" outcome rather than a gap.
// ---------------------------------------------------------------------------

export interface ModifierMask {
  readonly mod: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}

export function modifierMaskFromEvent(event: KeyboardEvent): ModifierMask {
  return {
    mod: hasPlatformModKey(event),
    shift: event.shiftKey,
    alt: event.altKey,
  };
}

export function hasPlatformModKey(event: KeyboardEvent): boolean {
  return isMac() ? event.metaKey : event.metaKey || event.ctrlKey;
}

export function parseModifierChord(chord: ChordString): ModifierMask | null {
  if (chord.length === 0) return null;
  const tokens = chord.split("+");
  let mod = false;
  let shift = false;
  let alt = false;
  for (const t of tokens) {
    if (t === "mod") mod = true;
    else if (t === "shift") shift = true;
    else if (t === "alt") alt = true;
    else return null;
  }
  if (!mod && !shift && !alt) return null;
  return { mod, shift, alt };
}

export function modifierMaskMatches(
  chord: ChordString,
  mask: ModifierMask,
): boolean {
  const parsed = parseModifierChord(chord);
  if (parsed === null) return false;
  return (
    parsed.mod === mask.mod &&
    parsed.shift === mask.shift &&
    parsed.alt === mask.alt
  );
}

/**
 * Human label for a modifier-only chord with a specific digit suffix -
 * e.g. `formatModifierChordForDisplay("mod", "1")` → `⌘1`.
 */
export function formatModifierChordForDisplay(
  chord: ChordString,
  suffix: string,
): string {
  const parsed = parseModifierChord(chord);
  if (parsed === null) return `${chord}+${suffix}`;
  const segs: Array<string> = [];
  if (parsed.mod) segs.push(modLabel());
  if (parsed.shift) segs.push(shiftLabel());
  if (parsed.alt) segs.push(altLabel());
  segs.push(suffix);
  return isMac() ? segs.join("") : segs.join("+");
}

/** Extract a 0..9 digit from `KeyboardEvent.code`, or null. */
export function digitFromCode(code: string): number | null {
  if (code.startsWith("Digit") && code.length === 6) {
    const d = code.slice(5);
    if (/^\d$/.test(d)) return Number.parseInt(d, 10);
  }
  if (code.startsWith("Numpad") && code.length === 7) {
    const d = code.slice(6);
    if (/^\d$/.test(d)) return Number.parseInt(d, 10);
  }
  return null;
}

function formatKeyForDisplay(key: ChordKey): string {
  switch (key) {
    case "arrowup":
      return "↑";
    case "arrowdown":
      return "↓";
    case "arrowleft":
      return "←";
    case "arrowright":
      return "→";
    case "enter":
      return "Enter";
    case "escape":
      return "Esc";
    case "space":
      return "Space";
    case "tab":
      return "Tab";
    case "backspace":
      return "⌫";
    case "delete":
      return "Del";
    default:
      if (key.length === 1) return key.toUpperCase();
      return key;
  }
}
