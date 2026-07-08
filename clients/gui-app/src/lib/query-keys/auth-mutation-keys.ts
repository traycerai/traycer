export const authMutationKeys = {
  signIn: () => ["auth", "signIn"] as const,
  openVerificationPage: () => ["auth", "openVerificationPage"] as const,
  revokeUserSession: (familyId: string) =>
    ["auth", "revokeUserSession", familyId] as const,
  revokeAllSessions: () => ["auth", "revokeAllSessions"] as const,
  requestStepUpChallenge: () => ["auth", "requestStepUpChallenge"] as const,
  verifyStepUpChallenge: () => ["auth", "verifyStepUpChallenge"] as const,
};
