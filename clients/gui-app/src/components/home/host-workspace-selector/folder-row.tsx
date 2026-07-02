import { FileSliders, Folder, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { FolderLocationControl } from "./folder-location-control";
import { FolderBranchControl } from "./folder-branch-control";
import type { WorkspaceRunItem } from "./workspace-run-item";

/**
 * One folder row, laid out as a subgrid so the folder / location / branch /
 * actions cells align into columns across every row (the parent grid owns the
 * column template — see {@link WorkspaceFolderRows}). The controls call the
 * existing item handlers (`onSelectMode`, `onEmit`) and the surface's
 * `onEditEnvironment`; this component only renders. Edge states (`unresolved`,
 * `metadataPending`) render one cell spanning the trailing columns so the
 * folder column stays aligned. The row is the hover `group` for the delete.
 */
export function FolderRow(props: {
  readonly item: WorkspaceRunItem;
  readonly onEditEnvironment: (workspacePath: string) => void;
  /** Host-wide uncommitted counts keyed by worktree path. */
  readonly uncommittedByPath: ReadonlyMap<string, number>;
  /** Collision boundary for nested popovers (in-epic rows live in a popover). */
  readonly boundaryEl: HTMLElement | null;
  readonly readOnly: boolean;
}) {
  const { item } = props;

  return (
    <div
      className="group col-span-full grid grid-cols-subgrid items-center gap-x-2"
      data-testid="folder-row"
      data-path={item.displayPath}
    >
      <span
        className="inline-flex min-w-0 items-center gap-1.5 px-1.5 py-1 text-ui-sm text-[color:var(--fc-text,var(--color-muted-foreground))] opacity-[var(--fc-opacity,0.7)]"
        data-testid="folder-chip"
      >
        <Folder
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <span className="min-w-0 max-w-[min(40vw,11rem)] truncate">
          {item.displayName}
        </span>
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
      </span>
      <FolderRowBody
        item={item}
        readOnly={props.readOnly}
        boundaryEl={props.boundaryEl}
        uncommittedByPath={props.uncommittedByPath}
        onEditEnvironment={props.onEditEnvironment}
      />
    </div>
  );
}

/**
 * The cells after the folder name. The normal case is three grid cells
 * (Location, Branch, the ⚙ + delete actions); edge states render one cell
 * spanning columns 2…-1 so the folder column stays aligned.
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
  // with no way out. The delete hover-reveals like every other row's trash.
  if (item.unresolved) {
    return (
      <div className="col-[2/-1] flex min-w-0 items-center gap-2">
        <span className="text-ui-sm text-muted-foreground">Unavailable</span>
        {props.readOnly ? null : (
          <>
            {item.onLocate === null ? null : (
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
            <span className="ml-auto inline-flex shrink-0">
              <RemoveFolderButton item={item} />
            </span>
          </>
        )}
      </div>
    );
  }

  // Disk metadata still loading: show a loading affordance, no controls yet.
  if (item.metadataPending) {
    return (
      <div
        className="col-[2/-1] flex min-w-0 items-center gap-2 text-ui-sm text-muted-foreground"
        data-testid="folder-row-loading"
      >
        <AgentSpinningDots
          className="text-current"
          testId={undefined}
          variant="dots"
        />
        <span>Loading folder metadata…</span>
      </div>
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
      {props.readOnly ? (
        <span className="size-6" aria-hidden />
      ) : (
        <span className="flex items-center gap-0.5">
          <EnvironmentButton item={item} onEdit={props.onEditEnvironment} />
          <RemoveFolderButton item={item} />
        </span>
      )}
    </>
  );
}

/** The ⚙ button — opens the setup/teardown scripts modal in every mode. */
function EnvironmentButton(props: {
  readonly item: WorkspaceRunItem;
  readonly onEdit: (workspacePath: string) => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Edit setup and teardown scripts"
      title="Setup & teardown scripts"
      data-testid="folder-scripts-trigger"
      onClick={() => props.onEdit(props.item.displayPath)}
      className="text-muted-foreground opacity-0 transition-opacity hover:bg-accent/50 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
    >
      <FileSliders className="size-4" />
    </Button>
  );
}

function RemoveFolderButton(props: { readonly item: WorkspaceRunItem }) {
  const { item } = props;
  // Always rendered (even for a single folder), revealed on row hover/focus. The
  // last-folder / active-owner guard is the per-item `removeDisabled` (with a
  // tooltip), not a hidden button — so the delete option is always discoverable.
  const button = (
    <button
      type="button"
      aria-label={`Remove ${item.displayName}`}
      data-testid="folder-remove"
      disabled={
        item.onRemove === null || item.removePending || item.removeDisabled
      }
      onClick={item.onRemove ?? undefined}
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none transition-[opacity,color,background-color] hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/60 group-hover:opacity-100 disabled:cursor-not-allowed disabled:text-muted-foreground/60 disabled:hover:bg-transparent disabled:hover:text-muted-foreground/60"
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
  return button;
}
