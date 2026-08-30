import {
  CircleMinus,
  FileSliders,
  Folder,
  Pin,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { cn } from "@/lib/utils";
import { CopyPathButton } from "./copy-path-button";
import { FolderLocationControl } from "./folder-location-control";
import { FolderBranchControl } from "./folder-branch-control";
import {
  folderLocationValue,
  workspaceRunPath,
  type WorkspaceRunItem,
} from "./workspace-run-item";

/**
 * One compact single-line folder row using the parent grid's shared columns:
 * primary pin / folder / location / branch / actions. A filled pin marks the
 * primary folder; every other row keeps the same outline-pin slot. Actions are
 * always visible in a muted tone, brightening on hover/focus.
 */
export function FolderRow(props: {
  readonly item: WorkspaceRunItem;
  readonly onEditEnvironment: (workspacePath: string) => void;
  /** Host-wide uncommitted counts keyed by worktree path. */
  readonly uncommittedByPath: ReadonlyMap<string, number>;
  /** Collision boundary for nested popovers (in-epic rows live in a popover). */
  readonly boundaryEl: HTMLElement | null;
  readonly readOnly: boolean;
  readonly moveToRecent: boolean;
}) {
  const { item } = props;
  const runPath = workspaceRunPath(item);

  return (
    <div
      className="group col-span-full grid min-w-0 grid-cols-subgrid items-center @max-[28rem]:gap-y-0.5 @max-[28rem]:pb-1"
      data-testid="folder-row"
      data-path={item.displayPath}
    >
      <PrimaryPinControl item={item} readOnly={props.readOnly} />
      <span
        className="inline-flex w-full max-w-full min-w-0 items-center gap-1.5 px-1 py-1 text-ui-sm"
        data-testid="folder-chip"
      >
        <Folder
          className="size-3.5 shrink-0 text-muted-foreground/70"
          aria-hidden
        />
        {/* Scoped to the NAME, not the whole chip. The chip also holds the
              missing-folder warning and the copy-path button, each with its own
              tooltip - a chip-wide trigger meant hovering either one could
              surface the path tooltip alongside theirs. */}
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
        {/* Only when a NEW branch is actually the row's active choice - an
            import/local row never uses the generated proposal this warns
            about, so it would be noise there. Creation stays unblocked;
            this only makes the already-applied fallback visible. */}
        {item.branchPrefixWarning !== null &&
        folderLocationValue(item) === "worktree" ? (
          <TooltipWrapper
            label={item.branchPrefixWarning}
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            <TriangleAlert
              className="size-3.5 shrink-0 text-destructive opacity-100"
              aria-hidden
              data-testid="folder-row-branch-prefix-warning"
            />
          </TooltipWrapper>
        ) : null}
        {runPath === null ? null : (
          <CopyPathButton path={runPath} testId="folder-copy-path" />
        )}
        {item.metadataPending ? (
          <span
            className="inline-flex shrink-0"
            data-testid="folder-row-loading"
            aria-label="Loading folder metadata"
          >
            <AgentSpinningDots
              className="text-muted-foreground"
              testId={undefined}
              variant="dots"
            />
            <span className="sr-only">Loading folder metadata</span>
          </span>
        ) : null}
      </span>
      <FolderRowBody
        item={item}
        readOnly={props.readOnly}
        boundaryEl={props.boundaryEl}
        uncommittedByPath={props.uncommittedByPath}
        onEditEnvironment={props.onEditEnvironment}
        moveToRecent={props.moveToRecent}
      />
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
  readonly moveToRecent: boolean;
}) {
  const { item } = props;

  // Folder not available on the selected host (`presence: "absent"`, or no
  // summary after the listing settled). The row still offers both recoveries
  // — locate it on this host, or remove it — because an unresolved folder
  // otherwise blocks send (see `deriveResolvedWorkspaceAvailability`) with no
  // way out. `branchLabel` carries "Not available on <host label>".
  if (item.unresolved) {
    return (
      <>
        <div className="col-[3/5] flex min-w-0 items-center gap-2 @max-[28rem]:col-[2/3] @max-[28rem]:row-start-2">
          <span
            className="min-w-0 truncate text-ui-sm text-muted-foreground"
            data-testid="folder-row-not-available"
          >
            {item.branchLabel}
          </span>
          {props.readOnly || item.onLocate === null ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="folder-row-locate"
              onClick={item.onLocate}
            >
              Locate on this host…
            </Button>
          )}
        </div>
        <FolderRowActions
          item={item}
          readOnly={props.readOnly}
          onEditEnvironment={props.onEditEnvironment}
          moveToRecent={props.moveToRecent}
        />
      </>
    );
  }

  return (
    <>
      <div className="min-w-0 @max-[28rem]:col-[2/3] @max-[28rem]:row-start-2">
        <FolderLocationControl
          item={item}
          uncommittedByPath={props.uncommittedByPath}
          boundaryEl={props.boundaryEl}
          readOnly={props.readOnly}
        />
      </div>
      <div className="min-w-0 @max-[28rem]:col-[2/3] @max-[28rem]:row-start-3">
        <FolderBranchControl
          item={item}
          boundaryEl={props.boundaryEl}
          readOnly={props.readOnly}
        />
      </div>
      <FolderRowActions
        item={item}
        readOnly={props.readOnly}
        onEditEnvironment={props.onEditEnvironment}
        moveToRecent={props.moveToRecent}
      />
    </>
  );
}

/** Two stable trailing slots keep scripts and remove aligned across rows. */
function FolderRowActions(props: {
  readonly item: WorkspaceRunItem;
  readonly readOnly: boolean;
  readonly onEditEnvironment: (workspacePath: string) => void;
  readonly moveToRecent: boolean;
}) {
  if (props.readOnly) return null;
  const { item } = props;
  const showEnvironment = !item.unresolved && !item.metadataPending;
  return (
    <span
      className="col-start-5 grid shrink-0 grid-cols-2 items-center justify-self-end gap-0.5 @max-[28rem]:col-start-3 @max-[28rem]:row-start-1"
      data-testid="folder-row-actions"
    >
      <span className="inline-flex size-6 items-center justify-center">
        {showEnvironment ? (
          <EnvironmentButton item={item} onEdit={props.onEditEnvironment} />
        ) : null}
      </span>
      <span className="inline-flex size-6 items-center justify-center">
        <RemoveFolderButton item={item} moveToRecent={props.moveToRecent} />
      </span>
    </span>
  );
}

/** Stable first-column primary state: filled when primary, outline otherwise. */
function PrimaryPinControl(props: {
  readonly item: WorkspaceRunItem;
  readonly readOnly: boolean;
}) {
  const { item } = props;
  const primaryLocked = !item.canChangePrimary;
  if (item.isPrimary) {
    return (
      <TooltipWrapper
        label={
          primaryLocked
            ? "Primary folder. New agent commands and terminals start here. Primary cannot be changed after the agent starts."
            : "Primary folder. New agent commands and terminals start here."
        }
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <button
          type="button"
          aria-disabled
          aria-label="Primary folder information"
          className={cn(
            "inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
            primaryLocked ? "cursor-not-allowed" : "cursor-help",
          )}
          data-testid="folder-primary-pin"
        >
          <Pin className="size-3.5" aria-hidden fill="currentColor" />
        </button>
      </TooltipWrapper>
    );
  }
  if (item.canChangePrimary && !props.readOnly) {
    return <MakePrimaryButton item={item} />;
  }
  return (
    <TooltipWrapper
      label={
        item.canChangePrimary
          ? "Primary cannot be changed from this view."
          : "Primary cannot be changed after the agent starts."
      }
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <button
        type="button"
        className="inline-flex size-6 shrink-0 cursor-not-allowed items-center justify-center rounded-md text-muted-foreground/45 outline-none focus-visible:ring-2 focus-visible:ring-ring/45"
        aria-disabled
        aria-label="Not primary folder. Primary is locked"
        data-testid="folder-secondary-pin"
      >
        <Pin className="size-3.5" aria-hidden />
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

/**
 * The outline-pin action that switches primary to this row's folder.
 * Rendered in the first column for a non-primary row on a surface with
 * `canChangePrimary` (the primary row shows the filled status pin instead).
 * Always visible in the muted row-action tone (never hover-revealed or
 * `display: none`), so it stays discoverable and keyboard/screen-reader
 * reachable.
 */
function MakePrimaryButton(props: { readonly item: WorkspaceRunItem }) {
  const { item } = props;
  // ONE tooltip, not one per concern: when the pin is disabled the reason is
  // strictly more informative than restating the action, and rendering both
  // put two tooltips on a single trigger.
  const label =
    item.makePrimaryDisabled && item.makePrimaryDisabledReason !== null
      ? item.makePrimaryDisabledReason
      : "Set as primary";
  return (
    <TooltipWrapper
      label={label}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <button
        type="button"
        aria-label="Set as primary"
        aria-disabled={item.makePrimaryDisabled}
        data-testid="folder-make-primary"
        onClick={item.makePrimaryDisabled ? undefined : item.onMakePrimary}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-[var(--fc-opacity,0.7)] outline-none transition-[opacity,color,background-color] hover:bg-accent/50 hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/60 aria-disabled:cursor-not-allowed aria-disabled:text-muted-foreground/60 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground/60 aria-disabled:hover:opacity-[var(--fc-opacity,0.7)]"
      >
        <Pin className="size-3.5" />
      </button>
    </TooltipWrapper>
  );
}

function RemoveFolderButton(props: {
  readonly item: WorkspaceRunItem;
  readonly moveToRecent: boolean;
}) {
  const { item } = props;
  const removeIcon = props.moveToRecent ? (
    <CircleMinus className="size-3.5" />
  ) : (
    <Trash2 className="size-3.5" />
  );
  // Always rendered AND always visible (even for a single folder). The
  // last-folder / active-owner guard is the per-item `removeDisabled` (with a
  // tooltip), not a hidden button — so the delete option is always discoverable.
  const button = (
    <button
      type="button"
      aria-label={
        props.moveToRecent
          ? `Move ${item.displayName} to Recent`
          : `Remove ${item.displayName}`
      }
      data-testid="folder-remove"
      disabled={
        item.onRemove === null || item.removePending || item.removeDisabled
      }
      onClick={item.onRemove ?? undefined}
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-[var(--fc-opacity,0.7)] outline-none transition-[opacity,color,background-color] hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:text-muted-foreground/60 disabled:hover:bg-transparent disabled:hover:text-muted-foreground/60 disabled:hover:opacity-[var(--fc-opacity,0.7)]",
        props.moveToRecent
          ? "hover:bg-accent/50 hover:text-foreground"
          : "hover:bg-destructive/10 hover:text-destructive",
      )}
    >
      {item.removePending ? (
        <AgentSpinningDots
          className="text-current"
          testId={undefined}
          variant="dots"
        />
      ) : (
        removeIcon
      )}
    </button>
  );
  if (item.removeDisabled && item.removeDisabledReason !== null) {
    return (
      <TooltipWrapper
        label={item.removeDisabledReason}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <span className="inline-flex shrink-0">{button}</span>
      </TooltipWrapper>
    );
  }
  if (props.moveToRecent) {
    return (
      <TooltipWrapper
        label="Move to Recent"
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        {button}
      </TooltipWrapper>
    );
  }
  return button;
}
