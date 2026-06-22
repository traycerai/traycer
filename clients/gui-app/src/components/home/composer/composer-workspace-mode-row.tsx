import type { ReactNode } from "react";
import { AgentModeReadonlyLabel } from "@/components/home/pickers/agent-mode-toggle";
import type { AgentMode } from "@/components/home/data/landing-options";

interface ComposerWorkspaceRowProps {
  /**
   * The collapsed workspace-controls cluster: Location / Mode+branch /
   * Environment chips (and any trailing chip such as context usage). The
   * caller composes the chips; this row only lays them out.
   */
  readonly workspaceControls: ReactNode;
}

interface ComposerReadonlyWorkspaceModeRowProps {
  readonly workspaceSlot: ReactNode;
  readonly agentMode: AgentMode | null;
}

export function ComposerWorkspaceRow(props: ComposerWorkspaceRowProps) {
  return (
    <div className="@container grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 overflow-hidden">
      {props.workspaceControls}
    </div>
  );
}

export function ComposerReadonlyWorkspaceModeRow(
  props: ComposerReadonlyWorkspaceModeRowProps,
) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">{props.workspaceSlot}</div>
      {props.agentMode === null ? null : (
        <AgentModeReadonlyLabel value={props.agentMode} />
      )}
    </div>
  );
}
