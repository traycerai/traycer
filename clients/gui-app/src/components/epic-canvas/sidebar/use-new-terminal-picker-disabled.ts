import {
  hasStageableNewSandboxRow,
  useNewSandboxRowInputs,
} from "@/components/composer/new-sandbox-rows";
import { usePoolComputerUnavailable } from "@/hooks/host/use-pool-computer-unavailable";
import {
  useSurfaceHostPin,
  useTabSurfaceKey,
} from "@/hooks/host/use-surface-host-pin";
import { stageTakingTerminal } from "@/lib/sandboxes/staged-terminal-target";
import { useStagedSandbox } from "@/stores/composer/staged-sandbox-store";

/** The picker can launch against its resolved computer or through its sandbox rows. */
export function useNewTerminalPickerDisabled(tabId: string): boolean {
  const surfaceKey = useTabSurfaceKey("new-terminal", tabId);
  const { resolvedHostId } = useSurfaceHostPin(surfaceKey);
  const noComputer = usePoolComputerUnavailable(resolvedHostId);
  const stage = stageTakingTerminal(useStagedSandbox(surfaceKey));
  const inputs = useNewSandboxRowInputs(noComputer && stage === null);
  return noComputer && stage === null && !hasStageableNewSandboxRow(inputs);
}
