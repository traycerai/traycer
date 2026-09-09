import { useMemo, type ReactNode } from "react";
import {
  WorktreeScriptsDialog,
  type WorktreeScriptsContext,
} from "@/components/home/worktree/worktree-scripts-dialog";
import { useEpicAppearanceSource } from "@/hooks/appearance/use-workspace-appearance";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useWorktreeListByWorkspacePathsForClient } from "@/hooks/worktree/use-worktree-list-by-workspace-paths-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The SAME dialog the workspace picker's ⚙ opens, pointed at the repo this
 * epic's primary folder resolves to. A tab knows a repository root and nothing
 * about worktree staging, so the context is pre-create shaped (no owner, no
 * binding) - the edit lands on the repo's own committed
 * `.traycer/environment.json`, which is where identity belongs anyway.
 */
export function TabRepositorySettingsDialog(props: {
  readonly epicId: string;
  readonly hostId: string | null;
  /** The strip already resolved this for a repo that has an identity. */
  readonly identityPath: string | null;
  readonly onClose: () => void;
}): ReactNode {
  const source = useEpicAppearanceSource({
    hostId: props.identityPath === null ? props.hostId : null,
    epicId: props.epicId,
  });
  const workspacePath = props.identityPath ?? source.workspacePath;
  const hostId = source.hostId ?? props.hostId;
  const hostClient = useHostClientForHostId(hostId);
  const summaries = useWorktreeListByWorkspacePathsForClient(hostClient, {
    workspacePaths: workspacePath === null ? [] : [workspacePath],
    enabled: workspacePath !== null,
  });
  const summary =
    summaries.data?.workspaces.find(
      (entry) => entry.workspacePath === workspacePath,
    ) ?? null;
  const context = useMemo<WorktreeScriptsContext>(
    () => ({
      kind: "repository",
      epicId: props.epicId,
      hostId,
      hostClient,
    }),
    [props.epicId, hostId, hostClient],
  );
  if (workspacePath !== null && summary !== null) {
    return (
      <WorktreeScriptsDialog
        open
        target={{ workspacePath, summary }}
        context={context}
        onOpenChange={(next) => {
          if (!next) props.onClose();
        }}
      />
    );
  }

  // Still resolving the folder (the appearance source hasn't produced a
  // `workspacePath` yet) or the summary query hasn't landed - the dialog
  // opens immediately either way so the click that triggered it always gets
  // visible feedback, never a silent no-op.
  const pending = workspacePath === null || summaries.isPending;
  const failureMessage = summaries.isError
    ? "Something went wrong loading this repository's settings."
    : "Couldn't find this repository's settings.";
  return (
    <TabRepositorySettingsDialogShell
      pending={pending}
      errorMessage={pending ? null : failureMessage}
      onRetry={() => {
        void summaries.refetch();
      }}
      onClose={props.onClose}
    />
  );
}

/**
 * The dialog SHELL for the two states `WorktreeScriptsDialog` can't render
 * itself: still resolving the workspace/summary, or unable to (a failed
 * query, or a settled query with no matching entry). Opens immediately in
 * both cases - so the context-menu click that opened it always shows
 * something - and `onClose` always works, including mid-error, so the user
 * is never trapped.
 */
function TabRepositorySettingsDialogShell(props: {
  readonly pending: boolean;
  readonly errorMessage: string | null;
  readonly onRetry: () => void;
  readonly onClose: () => void;
}): ReactNode {
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
    >
      <DialogContent
        data-testid="tab-repository-settings-dialog-shell"
        className="sm:max-w-[min(52rem,var(--safe-area-width),calc(100%-2rem))]"
      >
        <DialogHeader>
          <DialogTitle>Repository settings</DialogTitle>
          <DialogDescription>
            {props.pending
              ? "Loading this repository's settings…"
              : "This repository's settings couldn't be loaded."}
          </DialogDescription>
        </DialogHeader>
        {props.pending ? (
          <div
            className="flex flex-col gap-3 py-2"
            data-testid="tab-repository-settings-dialog-loading"
            role="status"
            aria-live="polite"
          >
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
            <span className="sr-only">Loading repository settings…</span>
          </div>
        ) : (
          <div
            className="py-2 text-ui-xs text-destructive"
            role="alert"
            data-testid="tab-repository-settings-dialog-error"
          >
            <span>{props.errorMessage}</span>
          </div>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => props.onClose()}
          >
            Close
          </Button>
          {!props.pending ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={props.onRetry}
            >
              Retry
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
