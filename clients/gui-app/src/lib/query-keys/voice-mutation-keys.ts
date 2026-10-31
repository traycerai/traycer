/**
 * Mutation keys for the voice layer's writes: the voice session routes
 * (`/api/voice/sessions`), read through `AuthService` like the sandbox
 * control plane, and the shell's two voice calls on the runner host. One
 * builder per write so a surface's pending state can be read back by key.
 */
export const voiceMutationKeys = {
  mint: () => ["voice.sessions.mint"] as const,
  end: () => ["voice.sessions.end"] as const,
  /** The shell's flag that a window's voice is live (it hides, not closes). */
  shellLive: () => ["voice.shell.live"] as const,
  /** The microphone permission prompt. */
  microphoneAccess: () => ["voice.microphone.access"] as const,
};
