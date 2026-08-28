/**
 * The delay behind the sidebar's "driven by an agent" glyph.
 *
 * A tab can be claimed and released many times a second while an agent works,
 * so the glyph is delayed in BOTH directions: it appears only if the same set
 * of chats is still driving after the delay, and it leaves only if nothing is
 * driving after the delay. One pending timer at a time, tagged with the chat
 * set it was started for, so churn WITHIN that set does not keep pushing the
 * appearance further out while a genuinely different set restarts the wait.
 *
 * React-free on purpose: the timing rule is the part worth testing, and it
 * does not need a renderer to be exercised.
 */
export interface CoalesceTimer {
  readonly chatSignature: string;
  readonly handle: number;
}

/** The chat-set signature of a driver list; the empty string when idle. */
export function browserTabDriverChatSignature(
  drivers: readonly { readonly chatId: string }[],
): string {
  return [...new Set(drivers.map((driver) => driver.chatId))].sort().join("\0");
}

/**
 * Keeps a pending timer that is already waiting on `chatSignature`, and
 * otherwise cancels it and starts a fresh wait.
 */
export function restartCoalesceTimer(
  current: CoalesceTimer | null,
  chatSignature: string,
  delayMs: number,
  run: () => void,
): CoalesceTimer {
  if (current !== null && current.chatSignature === chatSignature) {
    return current;
  }
  cancelCoalesceTimer(current);
  return { chatSignature, handle: window.setTimeout(run, delayMs) };
}

export function cancelCoalesceTimer(current: CoalesceTimer | null): null {
  if (current !== null) window.clearTimeout(current.handle);
  return null;
}
