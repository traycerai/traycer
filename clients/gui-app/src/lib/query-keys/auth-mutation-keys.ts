export const authMutationKeys = {
  signIn: () => ["auth", "signIn"] as const,
  openVerificationPage: () => ["auth", "openVerificationPage"] as const,
};
