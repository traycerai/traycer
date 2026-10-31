/**
 * Mutation keys for the voice session routes (`/api/voice/sessions`), read
 * through `AuthService` like the sandbox control plane. One builder per
 * write so a surface's pending state can be read back by key.
 */
export const voiceMutationKeys = {
  mint: () => ["voice.sessions.mint"] as const,
  end: () => ["voice.sessions.end"] as const,
};
