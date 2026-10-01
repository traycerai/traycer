/**
 * Mutation keys for the profile-copy flow. Every key names the HOST the
 * mutation dials - the captured source host for operation verbs, the
 * destination for draft and sign-in verbs - so a pending state is never read
 * across two machines, and the attempt it acts on where there is one.
 */
export const profileCopyMutationKeys = {
  start: (sourceHostId: string) =>
    ["providers.profileCopy.start", sourceHostId] as const,
  cancel: (sourceHostId: string, operationId: string) =>
    ["providers.profileCopy.cancel", sourceHostId, operationId] as const,
  retry: (sourceHostId: string, operationId: string) =>
    ["providers.profileCopy.retry", sourceHostId, operationId] as const,
  cancelDraft: (destinationHostId: string, attemptId: string) =>
    [
      "providers.profileCopy.cancelDraft",
      destinationHostId,
      attemptId,
    ] as const,
  setPreference: (destinationHostId: string, attemptId: string) =>
    [
      "providers.profileCopy.setPreference",
      destinationHostId,
      attemptId,
    ] as const,
  verify: (destinationHostId: string, attemptId: string) =>
    ["providers.profileCopy.verify", destinationHostId, attemptId] as const,
  confirmVerification: (destinationHostId: string, attemptId: string) =>
    [
      "providers.profileCopy.confirmVerification",
      destinationHostId,
      attemptId,
    ] as const,
  confirmIdentity: (destinationHostId: string, attemptId: string) =>
    [
      "providers.profileCopy.confirmIdentity",
      destinationHostId,
      attemptId,
    ] as const,
  loginStart: (destinationHostId: string, attemptId: string) =>
    [
      "providers.profileCopy.login.start",
      destinationHostId,
      attemptId,
    ] as const,
  loginAwait: (destinationHostId: string, attemptId: string) =>
    [
      "providers.profileCopy.login.await",
      destinationHostId,
      attemptId,
    ] as const,
  loginTouch: (destinationHostId: string, attemptId: string) =>
    [
      "providers.profileCopy.login.touch",
      destinationHostId,
      attemptId,
    ] as const,
  loginSubmitCode: (destinationHostId: string, attemptId: string) =>
    [
      "providers.profileCopy.login.submitCode",
      destinationHostId,
      attemptId,
    ] as const,
  loginCancel: (destinationHostId: string, attemptId: string) =>
    [
      "providers.profileCopy.login.cancel",
      destinationHostId,
      attemptId,
    ] as const,
};
