import type { ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { cn } from "@/lib/utils";
import { OpenInEditorButton } from "@/components/worktree/open-in-editor-button";

export interface WorkspacePickerWithOpenerProps {
  readonly picker: ReactNode;
  readonly openTarget: {
    readonly workspacePath: string;
    readonly hostId: string;
  } | null;
  /** The panel's own client, forwarded to {@link OpenInEditorButton} - see its
   * `hostClient` doc for why this must be the panel's, not the app-wide one. */
  readonly hostClient: HostClient<HostRpcRegistry> | null;
}

/**
 * Pure layout wrapper pairing a workspace picker with the IDE opener so both
 * the file-tree and git-diff panels present an identical control. Owns the
 * flex geometry only - the picker stretches (`min-w-0 flex-1`) and the opener
 * stays `shrink-0`. Visibility/gating stays with each caller; the combo adds
 * no padding or background of its own.
 */
export function WorkspacePickerWithOpener(
  props: WorkspacePickerWithOpenerProps,
) {
  return (
    <div className={cn("flex min-w-0 items-center justify-between gap-1")}>
      <div className={cn("min-w-0 flex-1")}>{props.picker}</div>
      <OpenInEditorButton
        openTarget={props.openTarget}
        hostClient={props.hostClient}
      />
    </div>
  );
}
