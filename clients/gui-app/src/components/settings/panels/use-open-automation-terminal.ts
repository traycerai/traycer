import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import type {
  SandboxAutomationOpenTarget,
  SandboxPod,
} from "@traycer/protocol/host/sandbox-control";
import { useComposerSurfaceHostKey } from "@/hooks/host/use-composer-surface-host-pin";
import { useSandboxAutomationOpen } from "@/hooks/sandboxes/use-sandbox-automation-open-mutation";
import { useSandboxTeamPods } from "@/hooks/sandboxes/use-sandbox-automation-query";
import { openNewEpicIntent } from "@/lib/commands/actions/new-epic";
import { activateTabIntent } from "@/lib/tab-navigation";
import {
  settledForStartingAccount,
  signedInUserId,
} from "@/lib/sandboxes/sandbox-account-fence";
import { useLandingPanelStore } from "@/stores/home/landing-panel-store";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";

/**
 * An Automations row's `Open terminal`: a host that is not awake, or not
 * created yet, is started first (`POST /api/sandboxes/automation`, a team's
 * pod by its ordinal), and only once that succeeds is a folderless terminal
 * asked for on the host it answers with, in the start page's terminal panel,
 * and Settings closed onto a new task's tab. A failed start leaves Settings
 * open with the open's error toast. The composer's host and staging are left
 * as they were: Automations takes shells, never an agent's turn. `retry`
 * starts it again and opens nothing: a failed start's Retry.
 */
export function useOpenAutomationTerminal(input: {
  /** The row's host and id; `null` for an Automations host not created yet. */
  readonly existing: {
    readonly hostId: string;
    readonly sandboxId: string;
    readonly awake: boolean;
  } | null;
  /** The team's environment for a team pod; `null` for Personal's. */
  readonly teamEnvironmentId: string | null;
}): {
  readonly run: () => void;
  readonly retry: () => void;
  readonly starting: boolean;
} {
  const { existing, teamEnvironmentId } = input;
  const open = useSandboxAutomationOpen();
  const surfaceKey = useComposerSurfaceHostKey();
  const { close } = useSystemTabModalActions();
  const navigate = useNavigate();
  const podEnvironmentIds = useMemo(
    () => (teamEnvironmentId === null ? [] : [teamEnvironmentId]),
    [teamEnvironmentId],
  );
  const pods = useSandboxTeamPods(podEnvironmentIds);
  const openTerminal = (hostId: string): void => {
    const panel = useLandingPanelStore.getState();
    panel.clearTerminalRequest();
    panel.requestTerminal(surfaceKey, hostId);
    close();
    activateTabIntent(navigate, openNewEpicIntent(), undefined);
  };
  const target = (): SandboxAutomationOpenTarget | null =>
    automationOpenTarget(
      existing === null ? null : existing.sandboxId,
      teamEnvironmentId,
      teamEnvironmentId === null ? [] : (pods.get(teamEnvironmentId) ?? []),
    );
  const run = (): void => {
    if (existing !== null && existing.awake) {
      openTerminal(existing.hostId);
      return;
    }
    const startingAccount = { userId: signedInUserId() };
    // A failed start is the open's own error toast; Settings stays open.
    void open.mutateAsync(target()).then(
      (opened) => {
        if (!settledForStartingAccount(startingAccount)) return;
        openTerminal(opened.sandbox.hostId);
      },
      () => undefined,
    );
  };
  const retry = (): void => {
    open.mutate(target());
  };
  return { run, retry, starting: open.isPending };
}

/**
 * Personal's Automations opens with no body; a team's pod by its environment
 * and its ordinal, or the pod with headroom while the pod list is unread or
 * the pod is not created yet.
 */
function automationOpenTarget(
  sandboxId: string | null,
  teamEnvironmentId: string | null,
  pods: readonly SandboxPod[],
): SandboxAutomationOpenTarget | null {
  if (teamEnvironmentId === null) return null;
  const pod = pods.find((candidate) => candidate.sandbox.id === sandboxId);
  return { environmentId: teamEnvironmentId, ordinal: pod?.ordinal ?? null };
}
