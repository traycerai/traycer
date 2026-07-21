import { FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";

export function NoGitWorktrees() {
  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col items-center justify-center gap-2 text-center",
        "px-4 py-8",
      )}
    >
      <FolderOpen className="size-8 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">
        No git workspaces available
      </p>
      <p className="text-xs text-muted-foreground">
        Add workspaces to the agent to get started
      </p>
    </div>
  );
}
