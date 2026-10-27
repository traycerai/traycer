import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { v4 as uuidv4 } from "uuid";
import { useSandboxAutomationOpen } from "@/hooks/sandboxes/use-sandbox-automation-open-mutation";
import { useSandboxTeamPods } from "@/hooks/sandboxes/use-sandbox-automation-query";
import { openNewEpicIntent } from "@/lib/commands/actions/new-epic";
import { activateTabIntent } from "@/lib/tab-navigation";
import { automationTerminalTarget } from "@/lib/sandboxes/automation-terminal-target";
import { signedInUserId } from "@/lib/sandboxes/sandbox-account-fence";
import {
  useLandingPanelStore,
  type AutomationTerminalRequest,
} from "@/stores/home/landing-panel-store";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";

/** Reserve the terminal pane synchronously; that pane owns the wake and shell. */
export function useOpenAutomationTerminal(
  input: Pick<AutomationTerminalRequest, "existing" | "teamEnvironmentId">,
) {
  const { close } = useSystemTabModalActions();
  const navigate = useNavigate();
  const open = useSandboxAutomationOpen("inline");
  const environmentIds = useMemo(
    () => (input.teamEnvironmentId === null ? [] : [input.teamEnvironmentId]),
    [input.teamEnvironmentId],
  );
  const pods = useSandboxTeamPods(environmentIds);
  const run = (): void => {
    const operationId = uuidv4();
    const accepted = useLandingPanelStore.getState().openAutomationTerminal(
      {
        ...input,
        userId: signedInUserId(),
        startedAt: Date.now(),
        terminalId: `landing-term-${operationId}`,
      },
      `landing-terminal-${operationId}`,
    );
    if (!accepted) return;
    close();
    activateTabIntent(navigate, openNewEpicIntent(), undefined);
  };
  // The row's Retry wakes a failed sandbox without requesting a shell.
  const retry = (): void => {
    const target = automationTerminalTarget(
      input.existing?.sandboxId ?? null,
      input.teamEnvironmentId,
      input.teamEnvironmentId === null
        ? []
        : (pods.get(input.teamEnvironmentId) ?? []),
    );
    open.mutate(target);
  };
  return { run, retry, starting: open.isPending };
}
