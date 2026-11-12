/** Reachable failed-create categories and the sentence shown to the person. */
export const SANDBOX_FIRST_BOOT_FAILURE_COPIES = [
  ["boot-timeout", "The sandbox took too long to start."],
  ["wake-timeout", "The sandbox took too long to start."],
  ["wake-window-spent", "The sandbox took too long to start."],
  ["wake-prepare", "The sandbox couldn't finish setting up."],
  [
    "wake-complete:wake_cancelled",
    "The start was cancelled before it finished. Try creating the sandbox again.",
  ],
  ["wake-complete:generation_superseded", "A newer start replaced this one."],
  ["wake-complete:unknown", "The sandbox couldn't finish starting."],
  ["envelope-delivery", "The sandbox couldn't receive its settings."],
  ["chat-store-newer", "The sandbox needs an update to open its saved chats."],
  ["boot-token-mint", "The sandbox couldn't sign in to Traycer."],
  ["boot-token-delivery", "The sandbox couldn't sign in to Traycer."],
  ["grant_set_failed", "The sandbox couldn't get access to its settings."],
  [
    "environment_placement_failed",
    "The sandbox couldn't join the selected environment.",
  ],
  ["provider-unavailable", "Sandboxes aren't available right now."],
  ["provider-pending", "The sandbox service hasn't finished starting it."],
  ["create", "The sandbox service couldn't start it."],
  ["provider-error", "The sandbox service couldn't start it."],
] as const;
