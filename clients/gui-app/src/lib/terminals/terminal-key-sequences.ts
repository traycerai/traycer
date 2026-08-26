/**
 * Escape-sequence encoding for the mobile terminal key bar. Phones have no
 * Esc/Tab/Ctrl/arrow keys, so the bar injects the byte sequences a physical
 * keyboard would produce; the host PTY cannot tell the difference. This is the
 * bar's own encoding layer, deliberately separate from xterm's keyboard
 * handler: bar taps never produce `KeyboardEvent`s, so they never pass through
 * `attachCustomKeyEventHandler` or xterm's encoder.
 */

/**
 * DECCKM cursor-keys mode of the running program. Full-screen TUIs switch to
 * "application" (`SS3 A`-style arrows); plain shells stay "normal"
 * (`CSI A`-style). Read live from `term.modes.applicationCursorKeysMode` per
 * press - encoding one dialect unconditionally breaks arrows in the other
 * mode's programs.
 */
export type TerminalCursorKeyMode = "normal" | "application";

/** One-shot latched modifiers accompanying a key (Termux-style sticky keys). */
export interface TerminalKeyBarModifiers {
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

export const NO_TERMINAL_KEY_BAR_MODIFIERS: TerminalKeyBarModifiers = {
  ctrl: false,
  alt: false,
  shift: false,
};

/** Non-modifier keys the bar can send. Modifiers latch; they are not sent. */
export type TerminalKeyBarActionKey =
  | "escape"
  | "tab"
  | "space"
  | "enter"
  | "backspace"
  | "arrow-up"
  | "arrow-down"
  | "arrow-left"
  | "arrow-right";

type TerminalArrowKey =
  "arrow-up" | "arrow-down" | "arrow-left" | "arrow-right";

const ARROW_FINAL_BYTE: Record<TerminalArrowKey, string> = {
  "arrow-up": "A",
  "arrow-down": "B",
  "arrow-right": "C",
  "arrow-left": "D",
};

function isArrowKey(key: TerminalKeyBarActionKey): key is TerminalArrowKey {
  return key in ARROW_FINAL_BYTE;
}

export function encodeTerminalKeyBarKey(
  key: TerminalKeyBarActionKey,
  modifiers: TerminalKeyBarModifiers,
  cursorKeyMode: TerminalCursorKeyMode,
): string {
  if (isArrowKey(key)) {
    // Match the desktop Option+arrow chords (`terminal-line-edit.ts`): plain
    // Alt+left/right is the readline word-jump, not a CSI-modified arrow.
    if (modifiers.alt && !modifiers.ctrl && !modifiers.shift) {
      if (key === "arrow-left") return "\x1bb";
      if (key === "arrow-right") return "\x1bf";
    }
    return encodeArrow(ARROW_FINAL_BYTE[key], modifiers, cursorKeyMode);
  }
  return encodeEditingKey(key, modifiers);
}

function encodeEditingKey(
  key: Exclude<TerminalKeyBarActionKey, TerminalArrowKey>,
  modifiers: TerminalKeyBarModifiers,
): string {
  switch (key) {
    case "escape":
      // Modifiers add nothing to a bare ESC; a latched one is still consumed
      // by the caller so the latch cannot leak onto the following key.
      return "\x1b";
    case "tab":
      if (modifiers.shift) return "\x1b[Z"; // back-tab (Claude Code mode cycle)
      if (modifiers.alt) return "\x1b\t";
      return "\t";
    case "enter":
      // Chat TUIs parse ESC+CR as Shift+Enter / newline in kitty mode - same
      // sequence the desktop Cmd+Enter chord sends (`terminal-line-edit.ts`).
      if (modifiers.shift || modifiers.alt) return "\x1b\r";
      return "\r";
    case "space":
      if (modifiers.ctrl) return applyAltPrefix("\x00", modifiers); // NUL
      if (modifiers.alt) return "\x1b ";
      return " ";
    case "backspace":
      if (modifiers.alt) return "\x1b\x7f"; // delete word back
      if (modifiers.ctrl) return "\x08";
      return "\x7f";
  }
}

/**
 * xterm's modified-arrow form (`CSI 1;<mod> <final>`), where the modifier
 * parameter is 1 + shift(1) + alt(2) + ctrl(4). Modified arrows use the CSI
 * form in both cursor-key modes; only unmodified arrows switch to SS3.
 */
function encodeArrow(
  finalByte: string,
  modifiers: TerminalKeyBarModifiers,
  cursorKeyMode: TerminalCursorKeyMode,
): string {
  const parameter =
    1 +
    (modifiers.shift ? 1 : 0) +
    (modifiers.alt ? 2 : 0) +
    (modifiers.ctrl ? 4 : 0);
  if (parameter > 1) return `\x1b[1;${parameter}${finalByte}`;
  return cursorKeyMode === "application"
    ? `\x1bO${finalByte}`
    : `\x1b[${finalByte}`;
}

/**
 * Apply latched Ctrl/Alt to a character typed on the phone's own keyboard
 * (latched Ctrl + typed `c` -> `\x03`). Shift is bar-key-only: capitals come
 * from the phone keyboard's own shift, so a shift latch leaves text unchanged.
 * Returns null when the character has no control mapping under a Ctrl latch,
 * so the caller can decide to pass the input through untransformed.
 */
export function applyModifiersToTypedCharacter(
  character: string,
  modifiers: TerminalKeyBarModifiers,
): string | null {
  if (modifiers.ctrl) {
    const control = controlByteFor(character);
    if (control === null) return null;
    return applyAltPrefix(control, modifiers);
  }
  if (modifiers.alt) return `\x1b${character}`;
  return character;
}

function applyAltPrefix(
  sequence: string,
  modifiers: TerminalKeyBarModifiers,
): string {
  return modifiers.alt ? `\x1b${sequence}` : sequence;
}

/**
 * The classic Ctrl mapping: clear bits 6-7 of the ASCII code. Covers `a`-`z`,
 * `@ A-Z [ \ ] ^ _`, plus the two conventional extras (space -> NUL,
 * `?` -> DEL). Anything else has no control form.
 */
function controlByteFor(character: string): string | null {
  if (character === " ") return "\x00";
  if (character === "?") return "\x7f";
  if (character.length !== 1) return null;
  const upper = character.toUpperCase();
  const code = upper.charCodeAt(0);
  if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code & 0x1f);
  return null;
}
