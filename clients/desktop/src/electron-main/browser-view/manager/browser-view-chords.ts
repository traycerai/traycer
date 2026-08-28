import {
  isValidChordString,
  parseChordString,
  type ChordParts,
} from "@traycer-clients/shared/keybindings/chord-core";
import { log } from "../../app/logger";
import type { BrowserViewEntry } from "./browser-view-entry";
import type {
  BrowserViewInputModifier,
  BrowserViewWindow,
} from "../browser-view-port";

/**
 * Reserved-chord handling (BT-301/302). The renderer registers canonical
 * `ChordString` tokens through the preload bridge; the chord vocabulary and
 * its parser are owned by `@traycer-clients/shared/keybindings/chord-core` -
 * this module only adds the two things Electron main needs on top: turning a
 * guest `before-input-event` into chord parts, and turning a matched chord's
 * key back into a `sendInputEvent` keyCode.
 *
 * Modifier semantics: on macOS `mod` is Command (Meta) and Control is a
 * DISTINCT modifier carried in `ctrl`; everywhere else `mod` IS Control, so a
 * registered `ctrl+k` and `mod+k` are the same gesture (folded at
 * registration by `resolveChordForPlatform`).
 */

export type HostPlatform = "darwin" | "other";

/**
 * The `before-input-event` fields chord matching reads. Structurally a subset
 * of Electron's `Input`, so the manager passes one straight through.
 */
export interface BrowserViewKeyInput {
  readonly key: string;
  readonly control: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}

export function hostPlatformFromProcessPlatform(
  processPlatform: string,
): HostPlatform {
  return processPlatform === "darwin" ? "darwin" : "other";
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

/**
 * Named keys forwardable to the host via `sendInputEvent`. This is Electron's
 * keyCode vocabulary, NOT the accelerator one chord-core's `toAccelerator`
 * uses (`Esc` vs `Escape`, `Enter` vs `Return`), so it stays a local table.
 */
const KEY_TO_SEND_CODE: Readonly<Record<string, string>> = {
  space: "Space",
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

/**
 * Electron `sendInputEvent` keyCode for replaying a matched chord's key into
 * the host window. Single characters (letters, digits, punctuation) pass
 * through as themselves; named keys map to accelerator codes. Null means
 * unmappable - callers must not intercept those chords at all rather than
 * swallow them.
 */
export function hostSendKeyCodeForToken(key: string): string | null {
  if (key.length === 1) return key.toUpperCase();
  if (/^f([1-9]|1\d|2[0-4])$/.test(key)) return key.toUpperCase();
  return KEY_TO_SEND_CODE[key] ?? null;
}

function chordFromKeyEvent(
  input: BrowserViewKeyInput,
  platform: HostPlatform,
): ChordParts | null {
  const key = input.key.trim().toLowerCase();
  if (key.length === 0 || BARE_MODIFIER_KEYS.has(key)) return null;
  return {
    key,
    mod: platform === "darwin" ? input.meta : input.control,
    ctrl: platform === "darwin" ? input.control : false,
    shift: input.shift,
    alt: input.alt,
  };
}

/**
 * Fold a registered chord into its platform-physical form: off macOS Control
 * IS the primary modifier, so `ctrl+k` collapses onto `mod+k`. Run once at
 * registration; matching is then plain field equality.
 */
function resolveChordForPlatform(
  chord: ChordParts,
  platform: HostPlatform,
): ChordParts {
  if (platform === "other" && chord.ctrl) {
    return { ...chord, mod: true, ctrl: false };
  }
  return chord;
}

function chordsEqual(a: ChordParts, b: ChordParts): boolean {
  return (
    a.key === b.key &&
    a.mod === b.mod &&
    a.ctrl === b.ctrl &&
    a.shift === b.shift &&
    a.alt === b.alt
  );
}

interface BrowserViewChordsOptions {
  readonly getWindow: (windowId: string) => BrowserViewWindow | null;
  /** Platform used to resolve reserved chords (BT-301). */
  readonly hostPlatform: HostPlatform;
}

/**
 * BT-302: reserved app chords win before the guest sees them. The chord set
 * is registered by the renderer; only interceptable+forwardable chords are
 * claimed, so pages keep everything the app cannot replay.
 */
export class BrowserViewChords {
  private readonly getWindow: (windowId: string) => BrowserViewWindow | null;
  private readonly hostPlatform: HostPlatform;
  private chords: readonly ChordParts[] = [];

  constructor(options: BrowserViewChordsOptions) {
    this.getWindow = options.getWindow;
    this.hostPlatform = options.hostPlatform;
  }

  /** BT-303 wire-in: replace the registered chord set at runtime. */
  setTokens(tokens: readonly string[]): void {
    const parsed: ChordParts[] = [];
    for (const token of tokens) {
      if (!isValidChordString(token)) continue;
      const base = parseChordString(token);
      if (base === null) continue;
      // Unmodified chords would swallow ordinary typing inside the page.
      if (!base.mod && !base.ctrl && !base.shift && !base.alt) continue;
      // Only claim chords we can actually replay to the host window.
      if (hostSendKeyCodeForToken(base.key) === null) continue;
      parsed.push(resolveChordForPlatform(base, this.hostPlatform));
    }
    this.chords = parsed;
    log.info("[browser-view] reserved chords updated", {
      count: parsed.length,
      tokens,
    });
  }

  match(input: BrowserViewKeyInput): ChordParts | null {
    if (this.chords.length === 0) return null;
    const event = chordFromKeyEvent(input, this.hostPlatform);
    if (event === null) return null;
    return this.chords.find((chord) => chordsEqual(chord, event)) ?? null;
  }

  /**
   * Replay a matched chord into the owning window's host renderer so its own
   * keybindings fire as if the guest never had focus. Unforwardable chords
   * are never matched in the first place (see `setTokens`'s keyCode gate).
   */
  forwardToHostWindow(entry: BrowserViewEntry, chord: ChordParts): void {
    const keyCode = hostSendKeyCodeForToken(chord.key);
    if (keyCode === null) return;
    const surface = entry.surface;
    if (surface === null) return;
    const window = this.getWindow(surface.windowId);
    const hostWebContents =
      window === null || window.isDestroyed() ? null : window.webContents;
    if (hostWebContents === null) return;
    const modifiers: BrowserViewInputModifier[] = [];
    if (chord.mod)
      modifiers.push(this.hostPlatform === "darwin" ? "meta" : "control");
    if (chord.ctrl) modifiers.push("control");
    if (chord.shift) modifiers.push("shift");
    if (chord.alt) modifiers.push("alt");
    hostWebContents.sendInputEvent({
      type: "keyDown",
      keyCode,
      modifiers,
    });
  }
}
