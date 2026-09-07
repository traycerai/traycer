/**
 * Platform-free core of the canonical `ChordString` format (`mod+ctrl+shift+alt+key`, modifiers in this fixed order and only when active - see `clients/gui-app/src/lib/keybindings/chord.ts` for the full contract).
 */
export type ChordString = string;

export type ChordKey = string;

export interface ChordParts {
  readonly mod: boolean;
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly key: ChordKey;
}

export function formatChord(parts: ChordParts): ChordString {
  const pieces: Array<string> = [];
  if (parts.mod) pieces.push("mod");
  if (parts.ctrl) pieces.push("ctrl");
  if (parts.shift) pieces.push("shift");
  if (parts.alt) pieces.push("alt");
  pieces.push(parts.key);
  return pieces.join("+");
}

export function parseChordString(chord: ChordString): ChordParts | null {
  if (chord.length === 0) return null;
  const tokens = chord.split("+");
  if (tokens.length === 0) return null;
  let mod = false;
  let ctrl = false;
  let shift = false;
  let alt = false;
  let key: ChordKey | null = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (i < tokens.length - 1) {
      if (t === "mod") mod = true;
      else if (t === "ctrl") ctrl = true;
      else if (t === "shift") shift = true;
      else if (t === "alt") alt = true;
      else return null;
    } else {
      key = t;
    }
  }
  if (key === null || key.length === 0) return null;
  return { mod, ctrl, shift, alt, key };
}

export type AcceleratorPlatform = "mac" | "other";

const KEY_TO_ACCELERATOR: Readonly<Record<string, string>> = {
  space: "Space",
  enter: "Return",
  escape: "Escape",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
};

function keyToAcceleratorToken(key: ChordKey): string {
  if (Object.hasOwn(KEY_TO_ACCELERATOR, key)) return KEY_TO_ACCELERATOR[key];
  if (/^f\d{1,2}$/.test(key)) return key.toUpperCase();
  if (key.length === 1) return key.toUpperCase();
  return key;
}

const NAMED_KEYS = new Set<string>(Object.keys(KEY_TO_ACCELERATOR));
const PUNCTUATION_KEYS = new Set<string>([
  ",",
  ".",
  "/",
  ";",
  "'",
  "`",
  "-",
  "=",
  "[",
  "]",
  "\\",
]);
const FUNCTION_KEY_PATTERN = /^f([1-9]|1\d|2[0-4])$/;
const LETTER_OR_DIGIT_KEY_PATTERN = /^[a-z0-9]$/;

function isSupportedKey(key: ChordKey): boolean {
  if (NAMED_KEYS.has(key)) return true;
  if (FUNCTION_KEY_PATTERN.test(key)) return true;
  if (key.length === 1) {
    return LETTER_OR_DIGIT_KEY_PATTERN.test(key) || PUNCTUATION_KEYS.has(key);
  }
  return false;
}

/** Canonical `ChordString`: round-trips parse/format and uses a supported key. Malformed chords at persistence/IPC must fall back to the definition default. */
export function isValidChordString(chord: ChordString): boolean {
  const parts = parseChordString(chord);
  if (parts === null) return false;
  if (!isSupportedKey(parts.key)) return false;
  return formatChord(parts) === chord;
}

/**
 * Canonical chord to Electron Accelerator. `platform` is passed in (this module has no navigator/process).
 * `mod`+`ctrl` must not fold into one Control key off Mac.
 */
export function toAccelerator(
  chord: ChordString,
  platform: AcceleratorPlatform,
): string {
  const parts = parseChordString(chord);
  if (parts === null) return chord;
  const pieces: Array<string> = [];
  if (parts.mod && parts.ctrl) {
    if (platform === "mac") {
      pieces.push("Command", "Control");
    } else {
      pieces.push("Control");
    }
  } else if (parts.mod) {
    pieces.push("CommandOrControl");
  } else if (parts.ctrl) {
    pieces.push("Control");
  }
  if (parts.shift) pieces.push("Shift");
  if (parts.alt) pieces.push("Alt");
  pieces.push(keyToAcceleratorToken(parts.key));
  return pieces.join("+");
}
