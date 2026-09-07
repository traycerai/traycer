/**
 * A tab can be claimed and released many times a second while an agent works, so the glyph is delayed in BOTH directions: it appears only if the same set of chats is still driving after the delay, and it leaves only if nothing is driving after the delay.
 */
export interface CoalesceTimer {
  readonly chatSignature: string;
  readonly handle: number;
}

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

/**
 * A chat the epic's records cannot resolve is named by its id rather than dropped - the tab IS being driven by it, and a shorter list would understate that.
 */
export function browserTabDriverNames(
  drivers: readonly { readonly chatId: string }[],
  chatById: ReadonlyMap<string, { readonly title: string }>,
): readonly string[] {
  return [
    ...new Set(
      drivers.map(
        (driver) => chatById.get(driver.chatId)?.title ?? driver.chatId,
      ),
    ),
  ];
}
