import {
  hasStageableNewSandboxRow,
  useNewSandboxRowInputs,
} from "@/components/composer/new-sandbox-rows";
import {
  readPoolComputerUnavailable,
  usePoolComputerUnavailable,
} from "@/hooks/host/use-pool-computer-unavailable";
import { useSandboxControlUnavailableReason } from "@/hooks/sandboxes/use-sandbox-control-unavailable-reason";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";
import {
  AVAILABLE_HOST_ROW_SURFACE_STATE,
  isHostOptionSelectable,
  pickableHostOptions,
} from "@/components/settings/host-scope/host-option-model";
import {
  useSurfaceHostPin,
  useTabSurfaceKey,
} from "@/hooks/host/use-surface-host-pin";
import { stageTakingTerminal } from "@/lib/sandboxes/staged-terminal-target";
import { terminalLaunchBlocked } from "@/lib/terminals/terminal-launch-availability";
import {
  readStagedSandbox,
  useStagedSandbox,
} from "@/stores/composer/staged-sandbox-store";

/** The picker can launch against its resolved computer or through its sandbox rows. */
export function useNewTerminalPickerDisabled(tabId: string): {
  readonly disabled: boolean;
  readonly readDisabled: () => boolean;
} {
  const surfaceKey = useTabSurfaceKey("new-terminal", tabId);
  const { resolvedHostId } = useSurfaceHostPin(surfaceKey);
  const noComputer = usePoolComputerUnavailable(resolvedHostId);
  const stage = stageTakingTerminal(useStagedSandbox(surfaceKey));
  const inputs = useNewSandboxRowInputs(noComputer && stage === null);
  const canWake = useSandboxControlUnavailableReason() === null;
  const hosts = useHostOptions().hosts;
  const blocked = (noResolvedComputer: boolean, hasStage: boolean): boolean =>
    terminalLaunchBlocked(
      {
        noResolvedComputer,
        hasStage,
        canStageNew: canWake && hasStageableNewSandboxRow(inputs),
        canWake,
        offeredHosts: noResolvedComputer
          ? pickableHostOptions(hosts, resolvedHostId).filter((host) =>
              isHostOptionSelectable(
                host,
                "pin",
                AVAILABLE_HOST_ROW_SURFACE_STATE,
              ),
            )
          : [],
      },
      readPoolComputerUnavailable,
    );
  return {
    disabled: blocked(noComputer, stage !== null),
    readDisabled: () =>
      blocked(
        readPoolComputerUnavailable(resolvedHostId),
        stageTakingTerminal(readStagedSandbox(surfaceKey)) !== null,
      ),
  };
}
