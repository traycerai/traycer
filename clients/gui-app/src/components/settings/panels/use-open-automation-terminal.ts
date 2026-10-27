import { useEffect, useMemo, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { v4 as uuidv4 } from "uuid";
import { useSandboxAutomationOpen } from "@/hooks/sandboxes/use-sandbox-automation-open-mutation";
import { useSandboxAutomation } from "@/hooks/sandboxes/use-sandbox-automation-query";
import { openNewEpicIntent } from "@/lib/commands/actions/new-epic";
import { activateTabIntent } from "@/lib/tab-navigation";
import { automationTerminalTarget } from "@/lib/sandboxes/automation-terminal-target";
import {
  settledForStartingAccount,
  signedInUserId,
} from "@/lib/sandboxes/sandbox-account-fence";
import { sandboxMutationKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useLandingPanelStore,
  type AutomationTerminalRequest,
} from "@/stores/home/landing-panel-store";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";

interface AutomationRowRetryIdentity {
  readonly userId: string | null;
  readonly sandboxId: string | null;
  readonly teamEnvironmentId: string | null;
}

/** Reserve the terminal pane synchronously; that pane owns the wake and shell. */
export function useOpenAutomationTerminal(
  input: Pick<AutomationTerminalRequest, "existing" | "teamEnvironmentId">,
) {
  const { close } = useSystemTabModalActions();
  const navigate = useNavigate();
  const open = useSandboxAutomationOpen("inline");
  const automation = useSandboxAutomation(input.teamEnvironmentId);
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const sandboxId = input.existing?.sandboxId ?? null;
  const { teamEnvironmentId } = input;
  const identity = useMemo(
    () => ({ userId, sandboxId, teamEnvironmentId }),
    [userId, sandboxId, teamEnvironmentId],
  );
  const currentIdentity = useRef<AutomationRowRetryIdentity | null>(identity);
  const heldRetry = useRef<AutomationRowRetryIdentity | null>(null);
  useEffect(() => {
    currentIdentity.current = identity;
    return () => {
      currentIdentity.current = null;
    };
  }, [identity]);
  // One mutation holds the click through lookup and wake, including a cold read.
  const retryOperation = useMutation({
    mutationKey: sandboxMutationKeys.automationRetry(
      userId,
      teamEnvironmentId,
      sandboxId,
    ),
    mutationFn: async (request: AutomationRowRetryIdentity): Promise<void> => {
      if (
        currentIdentity.current !== request ||
        !settledForStartingAccount(request)
      )
        return;
      const result =
        request.teamEnvironmentId === null
          ? null
          : await automation.refetch({ cancelRefetch: false });
      if (
        currentIdentity.current !== request ||
        !settledForStartingAccount(request)
      )
        return;
      if (result?.isError === true)
        throw new AutomationRowLookupError("lookup");
      const target = automationTerminalTarget(
        request.sandboxId,
        request.teamEnvironmentId,
        result?.data?.pods ?? [],
      );
      if (target === undefined) throw new AutomationRowLookupError("missing");
      await open.mutateAsync(target);
    },
    onSettled: (_data, _error, request) => {
      if (heldRetry.current === request) heldRetry.current = null;
    },
  });
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
    if (heldRetry.current === identity) return;
    heldRetry.current = identity;
    retryOperation.mutate(identity);
  };
  const currentRetry = retryOperation.variables === identity;
  return {
    run,
    retry,
    starting: currentRetry && retryOperation.isPending,
    failure: currentRetry
      ? automationRowRetryFailure(retryOperation.error)
      : null,
  };
}

class AutomationRowLookupError extends Error {
  constructor(kind: "lookup" | "missing") {
    super(
      kind === "missing"
        ? "This host no longer exists."
        : "Couldn't look up this host. Try again.",
    );
    this.name = "AutomationRowLookupError";
  }
}

function automationRowRetryFailure(error: Error | null): string | null {
  if (error === null) return null;
  return error instanceof AutomationRowLookupError
    ? error.message
    : "Couldn't start Automations. Try again.";
}
