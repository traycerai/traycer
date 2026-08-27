import type { Input } from "electron";
import {
  hostSendKeyCodeForToken,
  parseReservedChordToken,
  reservedChordFromKeyEvent,
  reservedChordMatchesEvent,
  resolveReservedChordForPlatform,
  type HostPlatform,
  type ReservedChord,
} from "../../../ipc-contracts/reserved-chords";
import { log } from "../../app/logger";
import type { BrowserViewEntry } from "./browser-view-entry";
import type {
  BrowserViewInputModifier,
  BrowserViewWindow,
} from "../browser-view-port";

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
  private chords: readonly ReservedChord[] = [];

  constructor(options: BrowserViewChordsOptions) {
    this.getWindow = options.getWindow;
    this.hostPlatform = options.hostPlatform;
  }

  /** BT-303 wire-in: replace the registered chord set at runtime. */
  setTokens(tokens: readonly string[]): void {
    const parsed: ReservedChord[] = [];
    for (const token of tokens) {
      const base = parseReservedChordToken(token);
      if (base === null) continue;
      // Only claim chords we can actually replay to the host window.
      if (hostSendKeyCodeForToken(base.key) === null) continue;
      parsed.push(resolveReservedChordForPlatform(base, this.hostPlatform));
    }
    this.chords = parsed;
    log.info("[browser-view] reserved chords updated", {
      count: parsed.length,
      tokens,
    });
  }

  match(input: Input): ReservedChord | null {
    if (this.chords.length === 0) return null;
    const event = reservedChordFromKeyEvent(
      {
        key: input.key,
        control: input.control,
        meta: input.meta,
        shift: input.shift,
        alt: input.alt,
      },
      this.hostPlatform,
    );
    if (event === null) return null;
    return (
      this.chords.find((chord) => reservedChordMatchesEvent(chord, event)) ??
      null
    );
  }

  /**
   * Replay a matched chord into the owning window's host renderer so its own
   * keybindings fire as if the guest never had focus. Unforwardable chords
   * are never matched in the first place (see `setTokens`'s keyCode gate).
   */
  forwardToHostWindow(entry: BrowserViewEntry, chord: ReservedChord): void {
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
