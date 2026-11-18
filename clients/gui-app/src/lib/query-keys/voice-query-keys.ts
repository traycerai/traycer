/**
 * Query keys for the voice routes (`/api/voice`), read through `AuthService`
 * and keyed by the host binding's id and the signed-in user's id. Ids only: a
 * query key is hashed by value, and the service object's value changes under
 * it, which would make every hash a new query and defeat "read once".
 */
export const voiceQueryKeys = {
  availability: (
    hostId: string | null,
    userId: string | null,
  ): readonly unknown[] => ["auth", "voice-availability", hostId, userId],
  availabilityAll: (): readonly unknown[] => ["auth", "voice-availability"],
  availabilityMissing: (): readonly unknown[] => [
    "auth",
    "voice-availability",
    "missing",
  ],
};
