import { useCallback } from "react";
import type { TuiHarnessId } from "@traycer/protocol/persistence/epic/schemas";
import type {
  WorktreeBindingWorkspaceMode,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";
import { useCreateTuiAgent } from "@/hooks/agent/use-create-tui-agent";
import { useWorktreeIntentMemoryStore } from "@/stores/worktree/worktree-intent-memory-store";
import {
  pendingTerminalAgentStagingKey,
  useWorktreeIntentStagingStore,
} from "@/stores/worktree/worktree-intent-staging-store";

export interface TerminalAgentLaunchSelection {
  readonly harnessId: TuiHarnessId;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly terminalAgentArgs: string | null;
  // Which of the harness's logged-in profiles (subscriptions) to launch this
  // agent on. `null` = the ambient/host login.
  readonly profileId: string | null;
}

export interface TerminalAgentWorktreeCreateInput extends TerminalAgentLaunchSelection {
  readonly worktreeIntent: WorktreeIntent | null;
  readonly workspaceMode: WorktreeBindingWorkspaceMode;
}

export interface TerminalAgentWorktreeGate {
  readonly isPending: boolean;
  /**
   * Launches a terminal agent with the selected harness/model/mode/args and
   * supplied worktree intent. A `null` worktree intent means no per-folder
   * binding was picked and the host should default to Local. The intent is
   * remembered per-epic so reopening this epic restores the same picks; the
   * pending-launcher staging slot is cleared.
   */
  readonly requestCreate: (input: TerminalAgentWorktreeCreateInput) => void;
}

export function useTerminalAgentWorktreeGate(
  epicId: string,
  tabId: string,
  // Host the agent launches on. The remembered per-epic intent is host-local
  // (its paths and branches only exist on one machine), so a `null` host - no
  // resolved target - records nothing rather than stamping another host's.
  hostId: string | null,
): TerminalAgentWorktreeGate {
  const terminalAgentCreate = useCreateTuiAgent();

  const requestCreate = useCallback(
    (input: TerminalAgentWorktreeCreateInput) => {
      const { worktreeIntent } = input;
      if (worktreeIntent !== null && worktreeIntent.entries.length > 0) {
        useWorktreeIntentMemoryStore
          .getState()
          .setEpicIntent(epicId, hostId, worktreeIntent, Date.now());
      }
      useWorktreeIntentStagingStore
        .getState()
        .clear(pendingTerminalAgentStagingKey(hostId, epicId));
      void terminalAgentCreate.create({
        epicId,
        tabId,
        parentId: null,
        title: "",
        placement: { kind: "active-tile" },
        harnessId: input.harnessId,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        forkSourceHarnessSessionId: null,
        sourceTuiAgentId: null,
        sourceProfileId: null,
        onStatusChange: null,
        worktreeIntent,
        workspaceMode: input.workspaceMode,
        terminalAgentArgs: input.terminalAgentArgs,
        profileId: input.profileId,
      });
    },
    [epicId, hostId, tabId, terminalAgentCreate],
  );

  return {
    isPending: terminalAgentCreate.isPending,
    requestCreate,
  };
}
