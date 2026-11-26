import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { isSleepingSandboxPick } from "@/components/settings/host-scope/host-option-model";

/**
 * Each entry supplies only the paths that pressing it can reach.
 * The landing gesture has a resolved computer and a stage, while the
 * pickers can also let the person choose an offered host or a New row.
 */
export function terminalLaunchBlocked(
  input: {
    readonly noResolvedComputer: boolean;
    readonly hasStage: boolean;
    readonly canStageNew: boolean;
    readonly canWake: boolean;
    readonly offeredHosts: readonly HostScopeOption[];
  },
  computerUnavailable: (hostId: string) => boolean,
): boolean {
  return (
    input.noResolvedComputer &&
    !input.hasStage &&
    !input.canStageNew &&
    !input.offeredHosts.some(
      (host) =>
        !computerUnavailable(host.hostId) ||
        (input.canWake && isSleepingSandboxPick(host)),
    )
  );
}
