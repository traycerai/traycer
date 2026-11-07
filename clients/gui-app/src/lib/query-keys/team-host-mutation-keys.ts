/** The team-host mint (traycer-server `/api/environments/{id}/team-host/*`). */
export const teamHostMutationKeys = {
  /** Every account's install-token mints, which an identity change drops. */
  installTokenAll: () => ["teamHost.installToken"] as const,
  /**
   * One account's mints for one environment. The account is in the key so
   * another account signed in on this app never reads a token it did not mint.
   */
  installToken: (userId: string | null, environmentId: string) =>
    ["teamHost.installToken", userId, environmentId] as const,
};
