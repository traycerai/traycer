import { Laptop, Split } from "lucide-react";
import type { WorkspaceRunMode } from "./workspace-run-item";

export function WorkspaceModeIcon(props: { readonly mode: WorkspaceRunMode }) {
  return props.mode === "worktree" ? (
    <Split className="size-3.5 shrink-0 rotate-90" />
  ) : (
    <Laptop className="size-3.5 shrink-0" />
  );
}
