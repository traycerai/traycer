/**
 * Platform-free core of the canonical `ChordString` format
 * (`mod+ctrl+shift+alt+key`, modifiers in this fixed order and only when
 * active - see `clients/gui-app/src/lib/keybindings/chord.ts` for the full
 * contract). This module never reads `navigator` or `process` so it stays
 * importable from both the Electron main process and the browser-safe
 * `gui-app` renderer; anything DOM-bound (event capture, display labels)
 * stays in gui-app's `chord.ts`, which delegates the parse/format core here.
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

/** The two platform buckets `toAccelerator` needs to disambiguate `mod`+`ctrl` combos. */
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

/**
 * Converts a canonical `ChordString` to Electron's `Accelerator` format (e.g.
 * `mod+shift+space` -> `CommandOrControl+Shift+Space`), the only place this
 * app's chord format leaves its own canon. `platform` is an explicit
 * parameter rather than sniffed - this module has no `navigator`/`process`
 * access - so the caller (Electron main via `process.platform`, or a
 * renderer via `isMac()`) supplies it directly.
 *
 * `mod` alone maps to Electron's own cross-platform `CommandOrControl` token
 * (Electron itself resolves it to Cmd on mac / Ctrl elsewhere), so most
 * chords need no platform branching at all. Platform only matters when `mod`
 * and `ctrl` are held at once: on mac they are genuinely distinct keys (⌘ and
 * ⌃), but elsewhere `mod` already resolves to Control, so folding both in
 * would double up the same physical key.
 *
 * Returns the chord unchanged if it fails to parse - callers only ever pass
 * chords that already round-tripped through `parseChordString`.
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
