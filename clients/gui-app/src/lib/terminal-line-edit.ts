/**
 * Translate Mac Cmd/Option line-edit chords into the escape sequences shells expect: Cmd+←/→ jump to line start/end, Option+←/→ jump by word, Cmd+⌫ kills to line start, and Cmd+Enter sends a TUI newline.
 */
export function translateLineEditChord(
  event: KeyboardEvent,
  options: { isMac: boolean },
): string | null {
  if (!options.isMac) return null;

  if (onlyModifier(event, "meta")) {
    if (event.key === "ArrowLeft") return "\x01"; // Ctrl-A: line start
    if (event.key === "ArrowRight") return "\x05"; // Ctrl-E: line end
    if (event.key === "Backspace") return "\x15\x1b[D"; // kill to line start
    // Chat TUIs parse ESC+CR as Shift+Enter / newline in kitty mode.
    if (event.key === "Enter") return "\x1b\r";
  }
  if (onlyModifier(event, "alt")) {
    if (event.key === "ArrowLeft") return "\x1bb"; // Alt-b: word back
    if (event.key === "ArrowRight") return "\x1bf"; // Alt-f: word forward
  }
  return null;
}

/** True when `mod` is the only non-shift modifier held. */
function onlyModifier(event: KeyboardEvent, mod: "meta" | "alt"): boolean {
  return (
    event.metaKey === (mod === "meta") &&
    event.altKey === (mod === "alt") &&
    !event.ctrlKey &&
    !event.shiftKey
  );
}
