import { teamHostMutationKeys } from "./team-host-mutation-keys";

export const teamComputerMutationKeys = {
  // The existing identity-transition bridge clears the whole credential prefix.
  installToken: (userId: string | null, environmentId: string) =>
    [
      ...teamHostMutationKeys.installTokenAll(),
      "team-computer",
      userId,
      environmentId,
    ] as const,
};
