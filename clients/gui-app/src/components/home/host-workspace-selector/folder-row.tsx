import { useState, type MouseEvent } from "react";
import {
  CircleDot,
  FileSliders,
  Folder,
  Pin,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { cn } from "@/lib/utils";
import { CopyPathButton } from "./copy-path-button";
import { FolderLocationControl } from "./folder-location-control";
import { FolderBranchControl } from "./folder-branch-control";
import {
  workspaceRunBranchSourceLabel,
  workspaceRunPath,
  type WorkspaceRunItem,
} from "./workspace-run-item";
import { WorkspaceBranchLabel } from "./workspace-branch-label";

/**
 * One compact single-line folder row using the parent grid's shared columns:
 * main-marker-or-checkbox / folder / location / branch / actions. The chat's
 * MAIN project shows a filled marker + a primary-tinted row and cannot be
 * unchecked - clicking another row (its name, or its empty background)
 * switches the main there instead. Checkboxes
 * mark ADDITIONAL projects only. The pin action (default project for new
 * chats) lives with the other row actions. Actions are always visible in a
 * muted tone, brightening on hover/focus.
 */
export function FolderRow(props: {
  readonly item: WorkspaceRunItem;
  /**
   * The global "Allow multiple folders in chat" preference. When off,
   * unselected rows drop their ADDITIONAL checkbox (a still-selected extra
   * keeps it so it can always be removed).
   */
  readonly multiSelectEnabled: boolean;
  readonly onEditEnvironment: (workspacePath: string) => void;
  /** Host-wide uncommitted counts keyed by worktree path. */
  readonly uncommittedByPath: ReadonlyMap<string, number>;
  /** Collision boundary for nested popovers (in-epic rows live in a popover). */
  readonly boundaryEl: HTMLElement | null;
  readonly readOnly: boolean;
}) {
  const { item } = props;
  // The chat/terminal's actual run path when it exists; the folder's own path
  // otherwise (a NEW worktree has no path on disk yet) - so every row offers
  // a copy action.
  const runPath = workspaceRunPath(item) ?? item.displayPath;
  const isMain = item.selected && item.isPrimary;
  const switchable = !props.readOnly && item.onUseAsMain !== null;
  const handleRowBackgroundClick = (
    event: MouseEvent<HTMLDivElement>,
  ): void => {
    const onUseAsMain = item.onUseAsMain;
    if (props.readOnly || onUseAsMain === null) return;
    if (!(event.target instanceof Element)) return;
    // Only the row's own EMPTY background is the switch surface: clicks on
    // portaled popover content (React events bubble through portals) and on
    // the row's interactive controls must not switch the main.
    if (!event.currentTarget.contains(event.target)) return;
    if (event.target.closest("button, a, input, label") !== null) return;
    onUseAsMain();
  };

  return (
    // The background click is a redundant POINTER shortcut for the fully
    // accessible use-as-main name button inside the row. The outer wrapper
    // remains presentational; the non-interactive contents group below gives
    // the row an accessible name without adding another tab stop.
    <div
      role="presentation"
      className={cn(
        "group col-span-full grid min-w-0 grid-cols-subgrid items-center rounded-md transition-colors",
        isMain && "bg-primary/5",
        switchable && "cursor-pointer hover:bg-accent/40 active:bg-accent/60",
      )}
      onClick={handleRowBackgroundClick}
      data-testid="folder-row"
      data-path={item.displayPath}
    >
      <div
        role="group"
        aria-label={`${item.displayName} project`}
        className="contents"
      >
        <FolderSelectControl
          item={item}
          multiSelectEnabled={props.multiSelectEnabled}
          readOnly={props.readOnly}
        />
        <span
          className="inline-flex w-full max-w-full min-w-0 items-center gap-1.5 px-1 py-1 text-ui-sm"
          data-testid="folder-chip"
        >
          <Folder
            className="size-3.5 shrink-0 text-muted-foreground/70"
            aria-hidden
          />
          <FolderNameControl item={item} readOnly={props.readOnly} />
          {item.missing ? (
            <TooltipWrapper
              label="This bound folder is missing on disk."
              side="top"
              sideOffset={undefined}
              align={undefined}
            >
              <TriangleAlert
                className="size-3.5 shrink-0 text-destructive opacity-100"
                aria-hidden
                data-testid="folder-row-missing"
              />
            </TooltipWrapper>
          ) : null}
          {/* Hover-revealed (with a keyboard-focus fallback): every row has a
              copy action now, and a constantly-visible icon per row is noise.
              Pushed to the column's right edge, clear of the name text. */}
          <span className="ml-auto inline-flex shrink-0 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
            <CopyPathButton path={runPath} testId="folder-copy-path" />
          </span>
        </span>
        <FolderRowBody
          item={item}
          readOnly={props.readOnly}
          boundaryEl={props.boundaryEl}
          uncommittedByPath={props.uncommittedByPath}
          onEditEnvironment={props.onEditEnvironment}
        />
      </div>
    </div>
  );
}

/**
 * Columns after folder identity. Edge states span the location and branch
 * tracks while preserving the final action column.
 */
function FolderRowBody(props: {
  readonly item: WorkspaceRunItem;
  readonly readOnly: boolean;
  readonly boundaryEl: HTMLElement | null;
  readonly uncommittedByPath: ReadonlyMap<string, number>;
  readonly onEditEnvironment: (workspacePath: string) => void;
}) {
  const { item } = props;

  // Folder not available on the selected host. The row still offers both
  // recoveries — locate it on this host, or remove it — because an unresolved
  // folder otherwise blocks send (see `deriveResolvedWorkspaceAvailability`)
  // with no way out.
  if (item.unresolved) {
    return (
      <>
        <div className="col-[3/5] flex min-w-0 items-center gap-2">
          <span className="text-ui-sm text-muted-foreground">Unavailable</span>
          {props.readOnly || item.onLocate === null ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="folder-row-locate"
              onClick={item.onLocate}
            >
              Locate folder…
            </Button>
          )}
        </div>
        <FolderRowActions
          item={item}
          readOnly={props.readOnly}
          onEditEnvironment={props.onEditEnvironment}
        />
      </>
    );
  }

  // Disk metadata still loading: show a loading affordance. The action cell
  // stays mounted (disabled pin + live remove) so the actions don't blink
  // out and back during the fetch, shifting tab order under the keyboard.
  if (item.metadataPending) {
    return (
      <>
        <div
          className="col-[3/5] flex min-w-0 items-center gap-2 text-ui-sm text-muted-foreground"
          data-testid="folder-row-loading"
        >
          <AgentSpinningDots
            className="text-current"
            testId={undefined}
            variant="dots"
          />
          <span>Loading folder metadata…</span>
        </div>
        <FolderRowActions
          item={item}
          readOnly={props.readOnly}
          onEditEnvironment={props.onEditEnvironment}
        />
      </>
    );
  }

  // A saved project not used by the current chat: keep its facts visible
  // (current branch), but not the interactive location/branch controls -
  // those configure the chat's run and only mean something once selected.
  // The branch fact sits in the Branch track (an empty Location cell keeps
  // the grid flow), so the column headers stay truthful for every row.
  if (!item.selected) {
    return (
      <>
        <div aria-hidden data-testid="folder-row-unselected-location" />
        <div
          className="flex min-w-0 items-center px-1.5 py-1 text-ui-sm text-muted-foreground"
          data-testid="folder-row-unselected-facts"
        >
          <WorkspaceBranchLabel
            target={item.branchLabel}
            source={workspaceRunBranchSourceLabel(item.currentIntent)}
            className={undefined}
          />
        </div>
        <FolderRowActions
          item={item}
          readOnly={props.readOnly}
          onEditEnvironment={props.onEditEnvironment}
        />
      </>
    );
  }

  return (
    <>
      <FolderLocationControl
        item={item}
        uncommittedByPath={props.uncommittedByPath}
        boundaryEl={props.boundaryEl}
        readOnly={props.readOnly}
      />
      <FolderBranchControl
        item={item}
        boundaryEl={props.boundaryEl}
        readOnly={props.readOnly}
      />
      <FolderRowActions
        item={item}
        readOnly={props.readOnly}
        onEditEnvironment={props.onEditEnvironment}
      />
    </>
  );
}

/** Three stable trailing slots keep pin, scripts, and remove aligned. */
function FolderRowActions(props: {
  readonly item: WorkspaceRunItem;
  readonly readOnly: boolean;
  readonly onEditEnvironment: (workspacePath: string) => void;
}) {
  if (props.readOnly) return null;
  const { item } = props;
  // Scripts are a property of the SAVED project (not the chat's selection),
  // so the ⚙ shows on unselected rows too - gated only on the metadata the
  // dialog needs being available.
  const showEnvironment = !item.unresolved && !item.metadataPending;
  return (
    <span
      className="col-start-5 grid shrink-0 grid-cols-3 items-center justify-self-end gap-0.5"
      data-testid="folder-row-actions"
    >
      <span className="inline-flex size-6 items-center justify-center">
        {item.onTogglePin === null ? null : <PinDefaultButton item={item} />}
      </span>
      <span className="inline-flex size-6 items-center justify-center">
        {showEnvironment ? (
          <EnvironmentButton item={item} onEdit={props.onEditEnvironment} />
        ) : null}
      </span>
      <span className="inline-flex size-6 items-center justify-center">
        <RemoveFolderButton item={item} />
      </span>
    </span>
  );
}

/**
 * The name area. On rows that can become the chat's main project it is a
 * button - clicking it SWITCHES the main there in one action (the previous
 * main leaves the chat; additional checked folders stay). The main row
 * itself, unresolved rows, and bound owners keep the plain name with the
 * path tooltip.
 */
function FolderNameControl(props: {
  readonly item: WorkspaceRunItem;
  readonly readOnly: boolean;
}) {
  const { item } = props;
  const switchable = !props.readOnly && item.onUseAsMain !== null;
  if (!switchable) {
    // Scoped to the NAME, not the whole chip. The chip also holds the
    // missing-folder warning and the copy-path button, each with its own
    // tooltip - a chip-wide trigger meant hovering either one could
    // surface the path tooltip alongside theirs.
    return (
      <TooltipWrapper
        label={item.displayPath}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <span className="min-w-0 truncate font-medium text-foreground/90">
          {item.displayName}
        </span>
      </TooltipWrapper>
    );
  }
  return (
    <TooltipWrapper
      label={`Use as main project · ${item.displayPath}`}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <button
        type="button"
        data-testid="folder-use-as-main"
        aria-label={`Use ${item.displayName} as the main project for this chat`}
        onClick={item.onUseAsMain}
        className="min-w-0 truncate rounded-sm text-left font-medium text-foreground/90 outline-none transition-colors hover:text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        {item.displayName}
      </button>
    </TooltipWrapper>
  );
}

/**
 * Stable first-column state. The chat's MAIN project shows a filled,
 * non-uncheckable marker (switch mains by clicking another row's name);
 * every other row shows the ADDITIONAL-folder checkbox. `onToggleSelected
 * === null` (read-only / transient fallback) keeps the column's width with
 * the state shown but inert.
 */
function FolderSelectControl(props: {
  readonly item: WorkspaceRunItem;
  readonly multiSelectEnabled: boolean;
  readonly readOnly: boolean;
}) {
  const { item } = props;
  if (item.selected && item.isPrimary) {
    return (
      <TooltipWrapper
        label={
          item.onUseAsMain === null && item.onToggleSelected === null
            ? "Main project. New agent commands and terminals start here."
            : "Main project. New agent commands and terminals start here. Click another project's row to switch."
        }
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <span
          className="inline-flex size-6 shrink-0 cursor-help items-center justify-center text-primary"
          data-testid="folder-main-marker"
        >
          <CircleDot className="size-4" role="img" aria-label="Main project" />
        </span>
      </TooltipWrapper>
    );
  }
  // Multi-select is a global opt-in: with it off, an unselected saved row
  // shows no checkbox at all (an empty spacer keeps the grid columns
  // aligned). A row still IN the chat keeps its checkbox regardless, so an
  // extra folder can always be removed.
  if (!props.multiSelectEnabled && !item.selected) {
    return (
      <span
        className="inline-flex size-6 shrink-0"
        aria-hidden
        data-testid="folder-select-spacer"
      />
    );
  }
  const inert = props.readOnly || item.onToggleSelected === null;
  const disabledReason = item.selectionDisabledReason;
  const label = additionalCheckboxLabel(item, inert, disabledReason);
  const checkbox = (
    <span className="inline-flex size-6 shrink-0 items-center justify-center">
      <Checkbox
        checked={item.selected}
        disabled={inert || disabledReason !== null}
        aria-label={`Also use ${item.displayName} in this chat`}
        data-testid="folder-select-checkbox"
        // The primitive's `border-input` outline all but vanishes on the dark
        // popover when unchecked - brighten it so the box reads as a control.
        className="border-muted-foreground/50 hover:border-muted-foreground/80"
        onCheckedChange={(checked) => {
          item.onToggleSelected?.(checked === true);
        }}
      />
    </span>
  );
  if (label === null) return checkbox;
  return (
    <TooltipWrapper
      label={label}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      {checkbox}
    </TooltipWrapper>
  );
}

/** Explains an editable or disabled additional-project checkbox. */
function additionalCheckboxLabel(
  item: WorkspaceRunItem,
  inert: boolean,
  disabledReason: string | null,
): string | null {
  if (disabledReason !== null) return disabledReason;
  if (inert) return null;
  return item.selected
    ? "Additional folder in this chat. Uncheck to keep it saved but leave it out."
    : "Also use this saved project in this chat, alongside the main project.";
}

/**
 * The saved-list pin: marks this project as the DEFAULT for brand-new tasks.
 * New chats inside an existing task inherit that task's workspace instead.
 * Filled when pinned; changing a chat's selection never moves it.
 */
function PinDefaultButton(props: { readonly item: WorkspaceRunItem }) {
  const { item } = props;
  return (
    <TooltipWrapper
      label={
        item.isPinned
          ? "Default project. New tasks start with this project selected."
          : "Set as the default project for new tasks."
      }
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <button
        type="button"
        aria-label={
          item.isPinned
            ? `${item.displayName} is the default project for new tasks`
            : `Set ${item.displayName} as the default project for new tasks`
        }
        aria-pressed={item.isPinned}
        data-testid="folder-pin-default"
        onClick={item.onTogglePin ?? undefined}
        className={cn(
          "inline-flex size-6 shrink-0 items-center justify-center rounded-md outline-none transition-[opacity,color,background-color] focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/60",
          item.isPinned
            ? "bg-primary/10 text-primary"
            : "text-muted-foreground opacity-[var(--fc-opacity,0.7)] hover:bg-accent/50 hover:text-foreground hover:opacity-100",
        )}
      >
        <Pin
          className="size-3.5"
          aria-hidden
          fill={item.isPinned ? "currentColor" : "none"}
        />
      </button>
    </TooltipWrapper>
  );
}

/** The ⚙ button — opens the setup/teardown scripts modal in every mode. */
function EnvironmentButton(props: {
  readonly item: WorkspaceRunItem;
  readonly onEdit: (workspacePath: string) => void;
}) {
  return (
    <TooltipWrapper
      label="Setup & teardown scripts"
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Edit setup and teardown scripts"
        data-testid="folder-scripts-trigger"
        onClick={() => props.onEdit(props.item.displayPath)}
        // Always visible (muted, brightening on hover/focus) - user decision:
        // hover-revealed row actions were not discoverable.
        className="text-muted-foreground opacity-[var(--fc-opacity,0.7)] transition-opacity hover:bg-accent/50 hover:text-foreground hover:opacity-100 focus-visible:opacity-100"
      >
        <FileSliders className="size-4" />
      </Button>
    </TooltipWrapper>
  );
}

/** Removes a saved project after explicit destructive confirmation. */
function RemoveFolderButton(props: { readonly item: WorkspaceRunItem }) {
  const { item } = props;
  // Deleting a saved project is confirmed first: the trash sits beside
  // frequently-clicked row controls, and the removal also drops the project
  // from the current chat's selection (other chats keep their binding).
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Always rendered AND always visible (even for a single folder). The
  // last-folder / active-owner guard is the per-item `removeDisabled` (with a
  // tooltip), not a hidden button — so the delete option is always discoverable.
  const button = (
    <button
      type="button"
      aria-label={`Remove ${item.displayName} from saved projects`}
      data-testid="folder-remove"
      disabled={
        item.onRemove === null || item.removePending || item.removeDisabled
      }
      onClick={() => {
        setConfirmOpen(true);
      }}
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-[var(--fc-opacity,0.7)] outline-none transition-[opacity,color,background-color] hover:bg-destructive/10 hover:text-destructive hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:text-muted-foreground/60 disabled:hover:bg-transparent disabled:hover:text-muted-foreground/60 disabled:hover:opacity-[var(--fc-opacity,0.7)]"
    >
      {item.removePending ? (
        <AgentSpinningDots
          className="text-current"
          testId={undefined}
          variant="dots"
        />
      ) : (
        <Trash2 className="size-3.5" />
      )}
    </button>
  );
  const confirmDialog = (
    <ConfirmDestructiveDialog
      open={confirmOpen}
      onOpenChange={setConfirmOpen}
      title={`Remove ${item.displayName} from saved projects?`}
      description="The project leaves your saved projects and the current chat. Other chats keep it. Nothing on disk is deleted."
      cascadeSummary={null}
      actionLabel="Remove"
      isPending={false}
      onConfirm={() => {
        setConfirmOpen(false);
        item.onRemove?.();
      }}
    />
  );
  if (item.removeDisabled && item.removeDisabledReason !== null) {
    return (
      <>
        <TooltipWrapper
          label={item.removeDisabledReason}
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <span className="inline-flex shrink-0">{button}</span>
        </TooltipWrapper>
        {confirmDialog}
      </>
    );
  }
  return (
    <>
      {button}
      {confirmDialog}
    </>
  );
}
