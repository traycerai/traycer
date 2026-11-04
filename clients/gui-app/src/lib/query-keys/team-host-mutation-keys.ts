/** The team-host mint (traycer-server `/api/environments/{id}/team-host/*`). */
export const teamHostMutationKeys = {
  installToken: (environmentId: string) =>
    ["teamHost.installToken", environmentId] as const,
};
