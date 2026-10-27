import { useCallback } from "react";
import type { ComposerHostNoticeState } from "@/components/home/composer/composer-host-notice";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { useSandboxCatalogue } from "@/hooks/sandboxes/use-sandbox-catalogue-query";
import {
  sandboxAgentNotOfferedNotice,
  type SandboxAgentRemedies,
} from "@/lib/sandboxes/sandbox-agent-refusal";
import type { StagedSandbox } from "@/stores/composer/staged-sandbox-store";

/**
 * Refuses an agent sandboxes do not offer before a staged send can create or
 * wake one. A server without offeredAgents leaves the verdict to the sandbox
 * host after creation. Configuration readiness is always checked there.
 */
export function useStagedSendSignInCheck(
  input: {
    readonly harnessId: GuiHarnessId | null;
    readonly active: boolean;
  } & SandboxAgentRemedies,
): (stage: StagedSandbox) => ComposerHostNoticeState | null {
  const {
    harnessId,
    active,
    onChooseModel,
    onOpenTerminalInstead,
    onChooseAnotherHost,
  } = input;
  const catalogue = useSandboxCatalogue(active);
  const offeredAgents = catalogue.data?.offeredAgents;
  const pending = catalogue.data === undefined && catalogue.isFetching;
  return useCallback((): ComposerHostNoticeState | null => {
    if (!active || harnessId === null) return null;
    if (pending)
      return {
        kind: "mirror",
        pending: true,
        message: "Checking which agents run on sandboxes.",
        action: null,
      };
    if (offeredAgents === undefined || offeredAgents.includes(harnessId))
      return null;
    return sandboxAgentNotOfferedNotice(harnessId, {
      onChooseModel,
      onOpenTerminalInstead,
      onChooseAnotherHost,
    });
  }, [
    active,
    harnessId,
    pending,
    offeredAgents,
    onChooseModel,
    onOpenTerminalInstead,
    onChooseAnotherHost,
  ]);
}
