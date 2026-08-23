/**
 * Reserved-chord contract (BT-301).
 *
 * The single source of truth for which keyboard chords the APP owns even when
 * a native browser tile has focus. The renderer registers its binding tokens
 * through the preload bridge; the main process matches guest
 * `before-input-event`s against them and forwards matches to the host window
 * so renderer-level bindings (command palette, tab management) fire.
 *
 * Deliberately SELF-CONTAINED plain data + pure functions: this file is on the
 * preload import surface (`src/ipc-contracts/`), which stays CommonJS and
 * free of runtime dependencies. It mirrors the gui-app chord vocabulary
 * (`mod+ctrl+shift+alt+key`, fixed modifier order, `mod` = platform-primary
 * modifier) without importing it — see
 * `@traycer-clients/shared/keybindings/chord-core` for the renderer-side core.
 *
 * Modifier semantics:
 *  - On macOS, `mod` is Command (Meta); Control is a DISTINCT modifier and is
 *    carried in `ctrl`.
 *  - Everywhere else, `mod` IS Control; a physical Control press resolves to
 *    `mod`, so a registered `ctrl+k` and `mod+k` are the same gesture there.
 */

export interface ReservedChord {
  /** Canonical key token: lowercase letter/digit/punctuation or named key ("enter", "arrowup"). */
  readonly key: string;
  readonly mod: boolean;
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}

export type HostPlatform = "darwin" | "other";

export function hostPlatformFromProcessPlatform(
  processPlatform: string,
): HostPlatform {
  return processPlatform === "darwin" ? "darwin" : "other";
}

export interface HostKeyEvent {
  /** KeyboardEvent-style `key` value as reported by before-input-event. */
  readonly key: string;
  readonly control: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}

const BARE_MODIFIER_KEYS = new Set<string>([
  "meta",
  "control",
  "shift",
  "alt",
  "os",
  "metaleft",
  "metaright",
  "controlleft",
  "controlright",
  "shiftleft",
  "shiftright",
  "altleft",
  "altright",
]);

/** Keys forwardable to the host via `sendInputEvent` keyCode. */
const KEY_TO_SEND_CODE: Readonly<Record<string, string>> = {
  enter: "Enter",
  escape: "Esc",
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

function normalizeKeyToken(rawKey: string): string | null {
  const key = rawKey.trim().toLowerCase();
  if (key.length === 0 || BARE_MODIFIER_KEYS.has(key)) return null;
  if (/^[a-z0-9]$/.test(key)) return key;
  if (/^f([1-9]|1[0-2])$/.test(key)) return key;
  return key;
}

export function normalizeReservedChord(chord: ReservedChord): ReservedChord | null {
  const key = normalizeKeyToken(chord.key);
  if (key === null) return null;
  return {
    key,
    mod: chord.mod === true,
    ctrl: chord.ctrl === true,
    shift: chord.shift === true,
    alt: chord.alt === true,
  };
}

/** Stable wire/log identifier, e.g. `mod+ctrl+shift+alt+key` (fixed order). */
export function reservedChordToken(chord: ReservedChord): string {
  const parts: string[] = [];
  if (chord.mod) parts.push("mod");
  if (chord.ctrl) parts.push("ctrl");
  if (chord.shift) parts.push("shift");
  if (chord.alt) parts.push("alt");
  parts.push(chord.key);
  return parts.join("+");
}

/**
 * Parse a renderer-side chord token (`parseChordString` vocabulary). Accepts
 * `mod`, `cmd`/`command`/`meta` (all become `mod`), `ctrl`/`control`,
 * `shift`, `alt`/`option`. Returns null for unparsable or modifier-only
 * input.
 */
export function parseReservedChordToken(
  token: string,
): ReservedChord | null {
  const segments = token
    .split("+")
    .map((segment) => segment.trim().toLowerCase())
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  let mod = false;
  let ctrl = false;
  let shift = false;
  let alt = false;
  let key: string | null = null;
  for (const segment of segments) {
    if (
      segment === "mod" ||
      segment === "cmd" ||
      segment === "command" ||
      segment === "meta" ||
      segment === "cmdorctrl" ||
      segment === "commandorcontrol"
    ) {
      mod = true;
      continue;
    }
    if (segment === "ctrl" || segment === "control") {
      // A literal `ctrl` segment implies the primary modifier on platforms
      // where Control IS the primary one; on macOS it stays distinct.
      ctrl = true;
      continue;
    }
    if (segment === "shift") {
      shift = true;
      continue;
    }
    if (segment === "alt" || segment === "option") {
      alt = true;
      continue;
    }
    if (key !== null) return null;
    key = normalizeKeyToken(segment);
  }
  if (key === null) return null;
  // On non-mac platforms a physical-Control chord is expressed with `mod`
  // when matched; keep both flags so darwin matching stays exact.
  if (!ctrl && !mod && !shift && !alt) {
    // Unmodified chords would swallow normal typing inside pages; refuse.
    return null;
  }
  return { key, mod, ctrl, shift, alt };
}

export function reservedChordFromKeyEvent(
  event: HostKeyEvent,
  platform: HostPlatform,
): ReservedChord | null {
  const key = normalizeKeyToken(event.key);
  if (key === null) return null;
  return {
    key,
    mod: platform === "darwin" ? event.meta : event.control,
    ctrl: platform === "darwin" ? event.control : false,
    shift: event.shift,
    alt: event.alt,
  };
}

/**
 * Does the incoming host key event match this registered chord? `event` must
 * already be normalized through `reservedChordFromKeyEvent` with the SAME
 * platform.
 */
/**
 * Fold a registered chord into its platform-physical form. On non-mac
 * platforms Control IS the primary modifier, so a `ctrl+k` registration and
 * `mod+k` collapse to the same gesture (`mod` set, `ctrl` cleared). Run this
 * once at registration; matching is then plain field equality against
 * `reservedChordFromKeyEvent` output built with the same platform.
 */
export function resolveReservedChordForPlatform(
  chord: ReservedChord,
  platform: HostPlatform,
): ReservedChord {
  if (platform === "other" && chord.ctrl) {
    return { ...chord, mod: true, ctrl: false };
  }
  return chord;
}

export function reservedChordMatchesEvent(
  chord: ReservedChord,
  event: ReservedChord,
): boolean {
  return (
    chord.key === event.key &&
    chord.mod === event.mod &&
    chord.ctrl === event.ctrl &&
    chord.shift === event.shift &&
    chord.alt === event.alt
  );
}

/**
 * Electron `sendInputEvent` keyCode for forwarding a matched chord's key to
 * the host window. Printable characters pass through as themselves; named
 * keys map to accelerator codes. Null means unmappable — callers should not
 * intercept those chords at all rather than swallow them.
 */
export function hostSendKeyCodeForToken(key: string): string | null {
  if (/^[a-z0-9]$/.test(key)) return key.toUpperCase();
  if (/^f([1-9]|1[0-2])$/.test(key)) return key.toUpperCase();
  const mapped = KEY_TO_SEND_CODE[key];
  return mapped ?? null;
}
