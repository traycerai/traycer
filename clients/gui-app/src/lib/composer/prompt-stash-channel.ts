export const PROMPT_STASH_CHANNEL = "traycer-gui-app:prompt-stash:v1";

/** Notify every other app window that the shared stash database was wiped. */
export function publishPromptStashReset(): void {
  if (typeof globalThis.BroadcastChannel !== "function") return;
  const channel = new globalThis.BroadcastChannel(PROMPT_STASH_CHANNEL);
  channel.postMessage({ type: "reset" });
  channel.close();
}
