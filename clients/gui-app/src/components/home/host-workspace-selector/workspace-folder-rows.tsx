import { useId, useMemo, useState, type ReactNode } from "react";
import { FolderPlus, RotateCw } from "lucide-react";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { Checkbox } from "@/components/ui/checkbox";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useHostQuery } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";
import { cn } from "@/lib/utils";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";
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
  // True only when the rows live inside a popover (in-epic): nested popovers
  // (branch form + its source dropdown) then portal into — and are collision-
  // bounded by — this container so they stay inside the parent popover and a
  // click inside them isn't treated as "interact outside". Inline (landing) it
  // must stay false, else the short inline container collision-clips the source
  // dropdown to near-zero height (it renders but reads as "missing").
  readonly nestedInPopover: boolean;
}) {
  const { items } = props;
  // The global multi-select preference gates the per-row ADDITIONAL
  // checkboxes; the bottom-line toggle below flips it. This is the one piece
  // of state this component reads/writes itself - it is a global UI
  // preference, not binding/staging/mutation logic (still item handlers).
  const allowMultipleFolders = useWorkspaceFoldersStore(
    (state) => state.allowMultipleFolders,
  );
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
  const multiToggle =
    props.readOnly ||
    !items.some((item) => item.onToggleSelected !== null) ? null : (
      <AllowMultipleFoldersToggle
        items={items}
        checked={allowMultipleFolders}
      />
    );

  if (items.length === 0) {
    return (
      <div
        className="flex w-full min-w-0 items-start gap-3"
        data-testid="workspace-folder-rows"
      >
        <div className="flex min-w-0 flex-col items-start gap-1.5">
          {props.bindingResolved ? (
            addFolder
          ) : (
            <span
              className="inline-flex items-center gap-2 text-ui-sm text-muted-foreground"
              data-testid="workspace-folder-rows-linking"
            >
              <AgentSpinningDots
                className="size-4 shrink-0 text-current"
                testId={undefined}
                variant="dots"
              />
              Linking workspace…
            </span>
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
      <div className="flex min-w-0 flex-1 flex-col items-stretch gap-1.5">
        <div
          className="grid w-full min-w-0 grid-cols-[1.5rem_minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1.25fr)_auto] items-center gap-x-1.5 gap-y-1.5"
          data-testid="workspace-folder-grid"
        >
          <div
            className="col-span-full grid min-w-0 grid-cols-subgrid items-center text-ui-xs font-medium tracking-wider text-muted-foreground/70 uppercase"
            data-testid="workspace-folder-header"
          >
            <span aria-hidden />
            <span className="px-1">Project</span>
            <span className="px-1.5">Location</span>
            <span className="px-1.5">Branch</span>
            <span aria-hidden />
          </div>
          {items.map((item) => (
            <FolderRow
              key={item.key}
              item={item}
              multiSelectEnabled={allowMultipleFolders}
              onEditEnvironment={props.onEditEnvironment}
              uncommittedByPath={uncommittedByPath}
              boundaryEl={nestedBoundaryEl}
              readOnly={props.readOnly}
            />
          ))}
        </div>
        {multiToggle === null && updateButton === null ? (
          addFolder
        ) : (
          <div className="flex w-full items-center justify-between gap-3">
            {addFolder}
            <div className="flex shrink-0 items-center gap-3">
              {multiToggle}
              {updateButton}
            </div>
          </div>
        )}
      </div>
      {trailing}
    </div>
  );
}

/**
 * The bottom-line "Allow multiple folders in chat" checkbox - the global
 * opt-in for ADDITIONAL folders (per-row checkboxes). Rendered only when the
 * surface has per-chat selection (some row carries a toggle handler), so
 * read-only and legacy surfaces are unchanged. Unticking collapses THIS
 * surface to its main project: every additional folder is deselected through
 * its own item handler (it stays in the saved list). Rows whose selection is
 * currently locked (`selectionDisabledReason`) are left as they are - the
 * preference still turns off, it just doesn't mutate a locked surface.
 */
function AllowMultipleFoldersToggle(props: {
  readonly items: ReadonlyArray<WorkspaceRunItem>;
  readonly checked: boolean;
}) {
  const checkboxId = useId();
  const setAllowMultipleFolders = useWorkspaceFoldersStore(
    (state) => state.setAllowMultipleFolders,
  );
  return (
    <span
      className="inline-flex shrink-0 items-center gap-2 px-1.5"
      data-testid="workspace-multi-folder-toggle"
    >
      <Checkbox
        id={checkboxId}
        checked={props.checked}
        data-testid="workspace-multi-folder-toggle-checkbox"
        // Match the row checkboxes: the default `border-input` outline is
        // near-invisible on the dark popover when unchecked.
        className="border-muted-foreground/50 hover:border-muted-foreground/80"
        onCheckedChange={(checked) => {
          const next = checked === true;
          setAllowMultipleFolders(next);
          if (next) return;
          for (const item of props.items) {
            // Honor the same per-row guard the checkboxes render under
            // (e.g. an active run locks a live binding): the preference
            // still flips off for future chats, but a locked surface keeps
            // its additional folders instead of mutating mid-run.
            if (
              item.selected &&
              !item.isPrimary &&
              item.selectionDisabledReason === null
            ) {
              item.onToggleSelected?.(false);
            }
          }
        }}
      />
      <label
        htmlFor={checkboxId}
        className="cursor-pointer text-ui-sm text-muted-foreground select-none"
      >
        Allow multiple folders in chat
      </label>
    </span>
  );
}

export function AddFolderButton(props: {
  readonly onAddFolder: AddFolderHandler;
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
}) {
  const button = (
    <button
      type="button"
      data-testid="folder-add"
      disabled={props.pending || props.disabled}
      onClick={() => {
        void props.onAddFolder();
      }}
      className={cn(
        // Stays muted in every surface (a secondary action), independent of the
        // `--fc-*` brightening the folder rows use in the fork / terminal panels.
        "inline-flex w-fit items-center gap-2 rounded-md px-1.5 py-1 text-ui-sm text-muted-foreground opacity-70 outline-none transition-[background-color,color,opacity] hover:bg-accent/50 hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground",
      )}
    >
      {props.pending ? (
        <AgentSpinningDots
          className="text-current"
          testId={undefined}
          variant="dots"
        />
      ) : (
        <FolderPlus className="size-4" />
      )}
      <span className="truncate">Add folder</span>
    </button>
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
