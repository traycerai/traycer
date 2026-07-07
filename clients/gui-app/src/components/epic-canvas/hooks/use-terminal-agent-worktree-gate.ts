import { useCallback } from "react";
import type { TuiHarnessId } from "@traycer/protocol/persistence/epic/schemas";
import type {
  WorktreeBindingWorkspaceMode,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";
import type { AgentMode } from "@/components/home/data/landing-options";
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
  readonly agentMode: AgentMode;
  readonly terminalAgentArgs: string | null;
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
): TerminalAgentWorktreeGate {
  const terminalAgentCreate = useCreateTuiAgent();

  const requestCreate = useCallback(
    (input: TerminalAgentWorktreeCreateInput) => {
      const { worktreeIntent } = input;
      if (worktreeIntent !== null && worktreeIntent.entries.length > 0) {
        useWorktreeIntentMemoryStore
          .getState()
          .setEpicIntent(epicId, worktreeIntent, Date.now());
      }
      useWorktreeIntentStagingStore
        .getState()
        .clear(pendingTerminalAgentStagingKey(epicId));
      void terminalAgentCreate.create({
        epicId,
        tabId,
        parentId: null,
        title: "",
        placement: { kind: "active-tile" },
        harnessId: input.harnessId,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        agentMode: input.agentMode,
        forkSourceHarnessSessionId: null,
        onStatusChange: null,
        worktreeIntent,
        workspaceMode: input.workspaceMode,
        terminalAgentArgs: input.terminalAgentArgs,
      });
    },
    [epicId, tabId, terminalAgentCreate],
  );

  return {
    isPending: terminalAgentCreate.isPending,
    requestCreate,
  };
}
