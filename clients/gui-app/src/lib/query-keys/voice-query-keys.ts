/**
 * Query keys for the voice routes (`/api/voice`), read through `AuthService`
 * like the sandbox control plane and keyed to the live service and the
 * signed-in user for the reason `sandboxQueryKeys` gives.
 */
export const voiceQueryKeys = {
  availability: (
    authService: object,
    userId: string | null,
  ): readonly unknown[] => ["auth", "voice-availability", authService, userId],
  availabilityAll: (): readonly unknown[] => ["auth", "voice-availability"],
  availabilityMissing: (): readonly unknown[] => [
    "auth",
    "voice-availability",
    "missing",
  ],
};
