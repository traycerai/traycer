import {
  applyModifiersToTypedCharacter,
  NO_TERMINAL_KEY_BAR_MODIFIERS,
  type TerminalKeyBarModifiers,
} from "@/lib/terminals/terminal-key-sequences";

/**
 * One-shot sticky-modifier latch for the mobile terminal key bar
 * (Termux-style: tap Ctrl, it lights up, the NEXT key gets the modifier).
 *
 * Module singleton rather than component state because the latch must combine
 * with characters typed on the phone's soft keyboard, which surface inside the
 * xterm engine's `onData` path (`terminal-tile-xterm.tsx`) - outside the bar's
 * React tree. A singleton is sufficient: the mobile view shows exactly one
 * terminal, and only the bar ever sets a latch, so desktop input always takes
 * the empty-latch fast path.
 */

type TerminalKeyBarModifierKey = "ctrl" | "alt" | "shift";

let latched: TerminalKeyBarModifiers = NO_TERMINAL_KEY_BAR_MODIFIERS;
const listeners = new Set<() => void>();

function setLatched(next: TerminalKeyBarModifiers): void {
  if (
    next.ctrl === latched.ctrl &&
    next.alt === latched.alt &&
    next.shift === latched.shift
  ) {
    return;
  }
  latched = next;
  for (const listener of listeners) listener();
}

/** Snapshot for `useSyncExternalStore`; referentially stable between changes. */
export function getTerminalKeyBarModifiers(): TerminalKeyBarModifiers {
  return latched;
}

export function subscribeTerminalKeyBarModifiers(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function toggleTerminalKeyBarModifier(
  key: TerminalKeyBarModifierKey,
): void {
  setLatched({ ...latched, [key]: !latched[key] });
}

/** Returns the active latch and clears it - the "one-shot" in one-shot latch. */
export function consumeTerminalKeyBarModifiers(): TerminalKeyBarModifiers {
  const consumed = latched;
  setLatched(NO_TERMINAL_KEY_BAR_MODIFIERS);
  return consumed;
}

/**
 * Applies a pending latch to input produced by typing (the xterm `onData`
 * path). No latch -> input passes through untouched (the desktop / common
 * case). With a latch, a single typed character is transformed (Ctrl+`c` ->
 * `\x03`) and the latch is consumed.
 *
 * Multi-character chunks pass through WITHOUT consuming: `onData` is not only
 * typing - the engine synthesizes reports on this path (focus-in `\x1b[I`
 * under DECSET 1004, mouse-tracking sequences), and IME compositions / pastes
 * also arrive as chunks. None of those are the keystroke the user latched
 * for, and dropping the latch on them would be silent (tap Ctrl, tap the
 * terminal to raise the keyboard -> focus report eats the Ctrl). Leaving it
 * armed is visible: the bar still shows the key lit.
 *
 * Bar keys are NOT routed here: the bar consumes the latch itself before
 * injecting via `term.input`, so by the time that injection re-enters
 * `onData` the latch is already empty.
 */
export function applyTerminalKeyBarLatchToTypedInput(data: string): string {
  if (!latched.ctrl && !latched.alt && !latched.shift) return data;
  if (data.length !== 1) return data;
  const modifiers = consumeTerminalKeyBarModifiers();
  const transformed = applyModifiersToTypedCharacter(data, modifiers);
  return transformed ?? data;
}

export function resetTerminalKeyBarLatchForTests(): void {
  latched = NO_TERMINAL_KEY_BAR_MODIFIERS;
  listeners.clear();
}
