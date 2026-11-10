import { useInstalledHostTeam } from "../host/install-auth";
import type { CommandFn } from "../runner/runner";

export function buildHostUseCommand(team: string): CommandFn {
  return async () => {
    const binding = await useInstalledHostTeam(team);
    return {
      data: { binding },
      human: `This computer runs ${binding.environment.label}.`,
      exitCode: 0,
    };
  };
}
