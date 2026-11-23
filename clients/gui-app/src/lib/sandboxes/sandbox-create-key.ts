/** Matches the create endpoint's 1–64 character clientRequestId contract. */
export function sandboxCreateKey(
  intent: "retry" | "team-setup" | "stage",
  id: string,
): string {
  const key = `${intent}:${id}`;
  if (id.length === 0 || key.length > 64) {
    throw new Error("Invalid sandbox create key length");
  }
  return key;
}

/** Derives a press's key from the failure it answers or repeats its refused send. */
export function sandboxCreateKeyForPress(
  baseKey: string,
  failedSandboxId: string | null,
  lastAttemptedKey: string | null,
): string {
  return failedSandboxId === null
    ? (lastAttemptedKey ?? baseKey)
    : sandboxCreateKey("retry", failedSandboxId);
}
