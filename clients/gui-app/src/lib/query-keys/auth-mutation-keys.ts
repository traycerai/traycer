export const authMutationKeys = {
  signIn: () => ["auth", "signIn"] as const,
  openVerificationPage: () => ["auth", "openVerificationPage"] as const,
  // Remote Host Support (§13, T16): "Update now" / auto-policy toggle /
  // "Apply now — ends N sessions", scoped per host so concurrent writes to
  // different rows never share a pending state.
  updateHostVersionPolicy: (hostId: string) =>
    ["auth", "updateHostVersionPolicy", hostId] as const,
};
