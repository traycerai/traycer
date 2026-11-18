import type { ReactNode } from "react";
import { ComposerNarrowProvider } from "@/components/home/composer/composer-narrow-context";
import { useComposerNarrowObserver } from "@/components/home/composer/composer-narrow-hooks";

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

/**
 * The narrow boundary for the controls it lays out. It renders beside
 * `ComposerShell`, not inside it, so the shell's narrow provider covers only
 * the editor and toolbar; the row measures its own width against the same
 * breakpoint and provides it to its controls.
 */
export function ComposerWorkspaceRow(props: ComposerWorkspaceRowProps) {
  const { ref: narrowRef, isNarrow } = useComposerNarrowObserver();
  return (
    <ComposerNarrowProvider isNarrow={isNarrow}>
      <div
        ref={narrowRef}
        className="@container grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 overflow-hidden"
      >
        {props.workspaceControls}
      </div>
    </ComposerNarrowProvider>
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
