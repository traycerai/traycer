import { useMemo, useState, type ReactNode } from "react";
import { FolderPlus, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useHostQuery } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";
import { cn } from "@/lib/utils";
import { FolderRow } from "./folder-row";
import type { WorkspaceRunItem } from "./workspace-run-item";

export type AddFolderHandler = () => Promise<boolean>;

/**
 * The flat one-folder-per-row renderer shared by both surfaces. The folders are
 * laid out in one shared grid: pin / folder / location / branch / actions.
 * The "＋ Add folder" button sits left-aligned below. `trailingSlot` (the
 * device chip on landing, `null` in-epic) is pushed to the far right to match
 * the composer's alignment. All controls call the EXISTING item handlers — this
 * component never owns binding, staging, or mutation logic.
 */
export function WorkspaceFolderRows(props: {
  readonly items: ReadonlyArray<WorkspaceRunItem>;
  readonly trailingSlot: ReactNode;
  readonly onAddFolder: AddFolderHandler;
  readonly addFolderPending: boolean;
  readonly addFolderDisabled: boolean;
  readonly addFolderDisabledReason: string | null;
  // Terminal-agent "Update": applies the staged folder edits and resumes the
  // PTY. `null` on chat / landing surfaces (no live session to resume), where
  // the button is hidden. When set, it renders to the right of "Add folder".
  readonly onUpdate: (() => void) | null;
  readonly updateEnabled: boolean;
  readonly updatePending: boolean;
  readonly onEditEnvironment: (workspacePath: string) => void;
  readonly readOnly: boolean;
  readonly bindingResolved: boolean;
  /** Recent tier; null for read-only and terminal-agent binding surfaces. */
  readonly recentWorkspaces: ReactNode;
  readonly moveToRecent: boolean;
  // True only when the rows live inside a popover (in-epic): nested popovers
  // (branch form + its source dropdown) then portal into — and are collision-
  // bounded by — this container so they stay inside the parent popover and a
  // click inside them isn't treated as "interact outside". Inline (landing) it
  // must stay false, else the short inline container collision-clips the source
  // dropdown to near-zero height (it renders but reads as "missing").
  readonly nestedInPopover: boolean;
}) {
  const { items } = props;
  // Captured so the branch-form's nested source dropdown uses this container as
  // its collision boundary (in-epic, where the rows live inside a popover).
  const [boundaryEl, setBoundaryEl] = useState<HTMLDivElement | null>(null);
  const nestedBoundaryEl = props.nestedInPopover ? boundaryEl : null;

  // Per-worktree uncommitted counts for the Location submenu annotation. Shares
  // the warm host-wide `worktree.listAllForHost` query key (same source as
  // Settings ▸ Worktrees). Keyed to the surface's host via the first item.
  const hostClient = items[0]?.hostClient ?? null;
  const hasAnyWorktrees = items.some(
    (item) =>
      (item.summary?.worktrees.filter((w) => !w.isMain).length ?? 0) > 0,
  );
  const hostWorktreesQuery = useHostQuery<
    HostRpcRegistry,
    "worktree.listAllForHost"
  >({
    cacheKeyIdentity: undefined,
    client: hostClient,
    method: "worktree.listAllForHost",
    // Whole-list mode (no per-viewport selection); this surface only reads the
    // cheap base fields (uncommitted counts), so no activity enrichment.
    params: {
      includeActivity: false,
      activityPaths: null,
      cursor: null,
      limit: null,
      // A background read: serve the host's TTL-cached view. Only the
      // Settings toolbar's explicit Refresh forces a disk recompute.
      forceRefresh: false,
    },
    options: { enabled: hasAnyWorktrees && !props.readOnly },
  });
  const uncommittedByPath = useMemo(() => {
    const byPath = new Map<string, number>();
    for (const entry of hostWorktreesQuery.data?.worktrees ?? []) {
      byPath.set(entry.worktreePath, entry.uncommittedCount);
    }
    return byPath;
  }, [hostWorktreesQuery.data]);

  const trailing =
    props.trailingSlot === null ? null : (
      <div className="ml-auto shrink-0">{props.trailingSlot}</div>
    );
  const addFolder = props.readOnly ? null : (
    <AddFolderButton
      onAddFolder={props.onAddFolder}
      pending={props.addFolderPending}
      disabled={props.addFolderDisabled}
      disabledReason={props.addFolderDisabledReason}
    />
  );
  // Terminal-agent "Update" action: pinned to the far right of the folder block
  // (opposite "Add folder"), styled like the row's select controls.
  const updateButton =
    props.onUpdate === null ? null : (
      <UpdateFoldersButton
        onUpdate={props.onUpdate}
        enabled={props.updateEnabled}
        pending={props.updatePending}
      />
    );

  const workspaceActions = (
    <div className="flex w-full min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
      {addFolder}
      {props.recentWorkspaces}
      {updateButton === null ? null : (
        <div className="ml-auto shrink-0">{updateButton}</div>
      )}
    </div>
  );

  if (items.length === 0) {
    return (
      <div
        className="flex w-full min-w-0 items-start gap-3"
        data-testid="workspace-folder-rows"
      >
        <div className="flex min-w-0 flex-1 flex-col items-stretch gap-1.5">
          {props.bindingResolved ? (
            workspaceActions
          ) : (
            <>
              <span
                className="inline-flex items-center gap-2 text-ui-sm text-muted-foreground"
                data-testid="workspace-folder-rows-linking"
              >
                <AgentSpinningDots
                  className="size-4 shrink-0 text-current"
                  testId={undefined}
                  variant="dots"
                />
                Linking folder…
              </span>
              {props.recentWorkspaces}
            </>
          )}
        </div>
        {trailing}
      </div>
    );
  }

  return (
    <div
      ref={setBoundaryEl}
      className="flex w-full min-w-0 items-start gap-3"
      data-testid="workspace-folder-rows"
    >
      <div className="@container flex min-w-0 flex-1 flex-col items-stretch gap-1.5">
        <div
          className="grid w-full min-w-0 grid-cols-[1.5rem_minmax(0,1.35fr)_minmax(0,0.85fr)_minmax(0,1.1fr)_auto] items-center gap-x-1.5 gap-y-1.5 @max-[28rem]:grid-cols-[1.5rem_minmax(0,1fr)_auto]"
          data-testid="workspace-folder-grid"
        >
          {items.map((item) => (
            <FolderRow
              key={item.key}
              item={item}
              onEditEnvironment={props.onEditEnvironment}
              uncommittedByPath={uncommittedByPath}
              boundaryEl={nestedBoundaryEl}
              readOnly={props.readOnly}
              moveToRecent={props.moveToRecent}
            />
          ))}
        </div>
        {workspaceActions}
      </div>
      {trailing}
    </div>
  );
}

export function AddFolderButton(props: {
  readonly onAddFolder: AddFolderHandler;
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
}) {
  const button = (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="rounded-lg text-muted-foreground"
      data-testid="folder-add"
      disabled={props.pending || props.disabled}
      onClick={() => {
        void props.onAddFolder();
      }}
    >
      {props.pending ? (
        <AgentSpinningDots
          className="text-current"
          testId={undefined}
          variant="dots"
        />
      ) : (
        <FolderPlus data-icon="inline-start" />
      )}
      <span className="truncate">Add folder</span>
    </Button>
  );
  if (props.disabled && props.disabledReason !== null) {
    return (
      <TooltipWrapper
        label={props.disabledReason}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <span className="inline-flex w-fit">{button}</span>
      </TooltipWrapper>
    );
  }
  return button;
}

/**
 * Applies the staged terminal-agent folder edits and resumes the PTY against
 * the new binding. Pinned to the far right of the folder block (opposite "Add
 * folder"), styled like the row's select controls. Disabled (muted) until there
 * is at least one staged change, so an accidental click can't pointlessly
 * restart the terminal; the tooltip explains the gated state.
 */
function UpdateFoldersButton(props: {
  readonly onUpdate: () => void;
  readonly enabled: boolean;
  readonly pending: boolean;
}) {
  const button = (
    <button
      type="button"
      data-testid="folder-update"
      disabled={!props.enabled || props.pending}
      onClick={props.onUpdate}
      className={cn(
        // Select-like chip matching the location / branch controls: bordered,
        // rounded, far-right. Primary accent when there are changes to apply;
        // muted + inert otherwise.
        "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-ui-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45",
        props.enabled && !props.pending
          ? "border-primary/40 bg-primary/5 text-primary hover:bg-primary/10"
          : "cursor-not-allowed border-border/60 text-muted-foreground opacity-60",
      )}
    >
      {props.pending ? (
        <AgentSpinningDots
          className="text-current"
          testId={undefined}
          variant="dots"
        />
      ) : (
        <RotateCw className="size-4" />
      )}
      <span className="truncate">Update</span>
    </button>
  );
  return (
    <TooltipWrapper
      label={
        props.enabled
          ? "Apply folder changes and restart the terminal"
          : "No folder changes to apply"
      }
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span className="inline-flex w-fit">{button}</span>
    </TooltipWrapper>
  );
}
