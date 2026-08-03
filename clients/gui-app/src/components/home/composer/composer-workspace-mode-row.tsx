import type { ReactNode } from "react";

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
    </div>
  );
}
