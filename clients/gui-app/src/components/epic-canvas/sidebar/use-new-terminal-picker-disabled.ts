import {
  hasStageableNewSandboxRow,
  useSandboxCatalogueReader,
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
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { useSandboxCatalogue } from "@/hooks/sandboxes/use-sandbox-catalogue-query";
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
  const { resolvedHostId, readResolvedHostId } = useSurfaceHostPin(surfaceKey);
  const noComputer = usePoolComputerUnavailable(resolvedHostId);
  const stage = stageTakingTerminal(useStagedSandbox(surfaceKey));
  const catalogue =
    useSandboxCatalogue(noComputer && stage === null).data ?? null;
  const readCatalogue = useSandboxCatalogueReader();
  // The control-plane reason is immutable for the mounted runner/build.
  const canWake = useSandboxControlUnavailableReason() === null;
  const { hosts, readHosts } = useHostOptions();
  const blocked = (
    hostId: string | null,
    paths: {
      readonly noResolvedComputer: boolean;
      readonly hasStage: boolean;
      readonly canStageNew: boolean;
    },
    offeredHosts: readonly HostScopeOption[],
  ): boolean =>
    terminalLaunchBlocked(
      {
        ...paths,
        canWake,
        offeredHosts: paths.noResolvedComputer
          ? pickableHostOptions(offeredHosts, hostId).filter((host) =>
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
    disabled: blocked(
      resolvedHostId,
      {
        noResolvedComputer: noComputer,
        hasStage: stage !== null,
        canStageNew: canWake && hasStageableNewSandboxRow(catalogue),
      },
      hosts,
    ),
    readDisabled: () => {
      const hostId = readResolvedHostId();
      if (!readPoolComputerUnavailable(hostId)) return false;
      return blocked(
        hostId,
        {
          noResolvedComputer: true,
          hasStage: stageTakingTerminal(readStagedSandbox(surfaceKey)) !== null,
          canStageNew: canWake && hasStageableNewSandboxRow(readCatalogue()),
        },
        readHosts(),
      );
    },
  };
}
