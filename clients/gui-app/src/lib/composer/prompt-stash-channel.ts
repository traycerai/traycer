export const PROMPT_STASH_CHANNEL = "traycer-gui-app:prompt-stash:v1";

/** Notify every other app window that the shared stash database was wiped. */
export function publishPromptStashReset(): void {
  if (typeof globalThis.BroadcastChannel !== "function") return;
  try {
    const channel = new globalThis.BroadcastChannel(PROMPT_STASH_CHANNEL);
    try {
      channel.postMessage({ type: "reset" });
    } finally {
      channel.close();
    }
  } catch {
    // Best-effort peer notification must never prevent the destructive wipe
    // from reaching its final reload/recovery step.
  }
}
