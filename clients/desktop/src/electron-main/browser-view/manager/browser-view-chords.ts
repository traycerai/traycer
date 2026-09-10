import {
  isValidChordString,
  normalizeCode,
  parseChordString,
  type ChordParts,
} from "@traycer-clients/shared/keybindings/chord-core";
import type { BrowserViewReservedChord } from "@traycer-clients/shared/platform/browser-view";
import { RunnerHostEvent } from "../../../ipc-contracts/ipc-channels";
import { log } from "../../app/logger";
import {
  toTileKey,
  type BrowserViewEntry,
  type BrowserViewSend,
} from "./browser-view-entry";
import type {
  BrowserViewInputModifier,
  BrowserViewWindow,
} from "../browser-view-port";

/**
 * Reserved-chord handling (BT-301/302). The renderer registers the whole
 * guest-focused input policy through the preload bridge - which chords outrank
 * the page, and what each one means. The chord vocabulary and its parser are
 * owned by `@traycer-clients/shared/keybindings/chord-core`; this module adds
 * what Electron main needs on top: turning a guest `before-input-event` into
 * chord parts, and acting on a match.
 *
 * A matched chord goes one of two ways, and the renderer's table decides
 * which. `command: null` is APP-FORWARDED: the key is replayed into the host
 * renderer so the app's own keybinding runs as if the guest never had focus.
 * A named command is BROWSER-SCOPED: the renderer is told to run it against
 * the focused tile's session tab. Either way the guest never sees the key and
 * the menu accelerator never fires, because the caller preventDefaults.
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
  /**
   * The PHYSICAL key, and the field a chord token is derived from.
   *
   * REQUIRED, and `undefined` is a value rather than an omission: every caller
   * must say what the physical key was, and `undefined` is how one says there
   * was none. Electron's `Input` always carries a real one, which is why the
   * sole non-test caller can pass it straight through; a synthetic input with
   * no physical key states that explicitly and takes the `key` fallback in
   * `chordKeyFromInput`.
   */
  readonly code: string | undefined;
  readonly control: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  /** Held-key repeat. A reserved chord is a COMMAND, so it fires once. */
  readonly isAutoRepeat: boolean;
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

/**
 * The canonical key token for one guest keystroke.
 *
 * From `code` FIRST, through the same `normalizeCode` the renderer uses. A
 * chord token names a PHYSICAL key, and `input.key` is the character that key
 * produces under the reader's layout - so deriving from it made the two halves
 * of this policy disagree about the very thing the shared table is supposed to
 * make single. On AZERTY the physical `1` arrives as `key: "&"` and the
 * physical `W` as `key: "z"`, so `mod+1` and `mod+w` both failed here while
 * the renderer had reserved them - the app-forwarded rows were lost and the
 * browser-scoped rows went to the guest instead of closing its tab.
 *
 * `key` remains the fallback for anything `normalizeCode` does not recognise,
 * and for a caller with no `code` at all, which is exactly today's behaviour
 * for those inputs rather than a new refusal.
 */
function chordKeyFromInput(input: BrowserViewKeyInput): string | null {
  const code = input.code;
  if (code !== undefined && code.length > 0) {
    const normalized = normalizeCode(code);
    if (normalized !== null) return normalized;
  }
  const key = input.key.trim().toLowerCase();
  if (key.length === 0 || BARE_MODIFIER_KEYS.has(key)) return null;
  return key;
}

function chordFromKeyEvent(
  input: BrowserViewKeyInput,
  platform: HostPlatform,
): ChordParts | null {
  const key = chordKeyFromInput(input);
  if (key === null) return null;
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

/** A registered policy row, resolved for this platform. */
export interface MatchedReservedChord extends ChordParts {
  readonly command: BrowserViewReservedChord["command"];
}

interface BrowserViewChordsOptions {
  readonly getWindow: (windowId: string) => BrowserViewWindow | null;
  /** Platform used to resolve reserved chords (BT-301). */
  readonly hostPlatform: HostPlatform;
  readonly send: BrowserViewSend;
}

/**
 * BT-302: reserved chords win before the guest sees them. The policy table is
 * registered by the renderer; only interceptable chords are claimed, so pages
 * keep everything the app cannot act on.
 */
export class BrowserViewChords {
  private readonly getWindow: (windowId: string) => BrowserViewWindow | null;
  private readonly hostPlatform: HostPlatform;
  private readonly send: BrowserViewSend;
  /**
   * PER WINDOW, because the table is not a property of the app.
   *
   * Each renderer derives its own set from its own surface state - a window
   * showing a Start Page browser reserves the panel's three extra chords, one
   * showing a canvas does not - and there is one manager for every window. Held
   * as a single array, the last window to register decided the policy for all
   * of them, and nothing re-registered on OS focus: focusing a Start Page
   * window whose tab state had not changed left it matching the canvas
   * window's table, so ⌘J and the digit shortcuts fell through to the guest,
   * while the canvas window swallowed landing-only keys into nothing.
   */
  private readonly chordsByWindow = new Map<
    string,
    readonly MatchedReservedChord[]
  >();

  constructor(options: BrowserViewChordsOptions) {
    this.getWindow = options.getWindow;
    this.hostPlatform = options.hostPlatform;
    this.send = options.send;
  }

  /**
   * BT-303 wire-in: replace the registered policy table for ONE window.
   *
   * Tables for windows that have since gone are dropped here rather than
   * through a teardown hook: a closed window never registers again, so a
   * registration from any surviving window is the last moment this map can be
   * pruned without inventing a lifecycle it does not have.
   */
  setReservedChords(
    windowId: string,
    reserved: readonly BrowserViewReservedChord[],
  ): void {
    const parsed: MatchedReservedChord[] = [];
    for (const { token, command } of reserved) {
      if (!isValidChordString(token)) continue;
      const base = parseChordString(token);
      if (base === null) continue;
      // Unmodified chords would swallow ordinary typing inside the page.
      if (!base.mod && !base.ctrl && !base.shift && !base.alt) continue;
      // App-forwarded chords are claimed only if they can be replayed; a
      // browser-scoped one never travels as a keystroke, so it has no such
      // requirement.
      if (command === null && hostSendKeyCodeForToken(base.key) === null) {
        continue;
      }
      parsed.push({
        ...resolveChordForPlatform(base, this.hostPlatform),
        command,
      });
    }
    this.chordsByWindow.set(windowId, parsed);
    for (const known of [...this.chordsByWindow.keys()]) {
      if (known !== windowId && this.getWindow(known) === null) {
        this.chordsByWindow.delete(known);
      }
    }
    log.info("[browser-view] reserved chords updated", {
      window: windowId,
      count: parsed.length,
      windows: this.chordsByWindow.size,
      tokens: reserved.map((entry) => entry.token),
    });
  }

  /**
   * Matching deliberately ignores `isAutoRepeat`: a repeat of a reserved chord
   * still has to be CLAIMED, or it reaches the focus-blind menu accelerator
   * this policy exists to displace (holding Cmd+W would close the app tab
   * while the browser tab's asynchronous close is still pending). Whether a
   * repeat also DISPATCHES is the seam's call - see
   * `handleBeforeInputEvent`, which suppresses it because every reserved
   * chord is one-shot.
   */
  match(
    windowId: string | null,
    input: BrowserViewKeyInput,
  ): MatchedReservedChord | null {
    // A guest with no window of its own claims nothing. Falling back to some
    // other window's table is exactly the defect this signature exists to
    // prevent, and letting the key reach the page is the safe direction: an
    // unclaimed chord is a shortcut that did not fire, a wrongly claimed one is
    // a keystroke the reader typed that vanished.
    if (windowId === null) return null;
    const chords = this.chordsByWindow.get(windowId) ?? [];
    if (chords.length === 0) return null;
    const event = chordFromKeyEvent(input, this.hostPlatform);
    if (event === null) return null;
    return chords.find((chord) => chordsEqual(chord, event)) ?? null;
  }

  /**
   * Act on a matched chord: replay an app-forwarded one into the host renderer
   * so its own keybindings fire, or name a browser-scoped command to the
   * renderer so it runs against this tile's session tab.
   */
  dispatch(
    surface: BrowserViewEntry["surface"],
    chord: MatchedReservedChord,
  ): void {
    if (surface === null) return;
    const window = this.getWindow(surface.windowId);
    const hostWebContents =
      window === null || window.isDestroyed() ? null : window.webContents;
    if (chord.command !== null) {
      // The guest owns OS keyboard focus. Anything that hands the user a
      // caret in the host chrome has to take that focus first, or they type
      // into the page while the field looks focused.
      if (chord.command === "focusAddressBar") hostWebContents?.focus();
      this.send(surface.windowId, RunnerHostEvent.browserViewTileCommand, {
        ...toTileKey(surface),
        command: chord.command,
      });
      return;
    }
    const keyCode = hostSendKeyCodeForToken(chord.key);
    if (keyCode === null) return;
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
