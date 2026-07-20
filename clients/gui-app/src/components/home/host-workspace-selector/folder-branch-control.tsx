import { useRef, useState } from "react";
import { ChevronDown, GitBranch } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";
import {
  ImportedWorktreeBranchForm,
  NewWorktreeForm,
} from "./new-worktree-form";
import {
  FOLDER_CONTROL_TRIGGER_CLASS,
  folderLocationValue,
  workspaceRunBranchSourceLabel,
  type WorkspaceRunItem,
} from "./workspace-run-item";
import { preserveWhenNestedOverlay } from "./preserve-when-nested-overlay";
import { WorkspaceBranchLabel } from "./workspace-branch-label";

/**
 * The per-row Branch control. In Local / Existing-worktree mode the branch is
 * fixed, so this renders a read-only label (`item.branchLabel`). In New-worktree
 * mode it is an interactive chip that opens the {@link NewWorktreeForm} in a
 * popover. Disabled (with the rebind tooltip) when `item.modeDisabled`.
 */
export function FolderBranchControl(props: {
  readonly item: WorkspaceRunItem;
  /** Collision boundary for the source dropdown nested inside the form. When
   * the rows live inside a popover (in-epic) this is that popover element. */
  readonly boundaryEl: HTMLElement | null;
  readonly readOnly: boolean;
}) {
  const { item } = props;
  const sourceLabel = workspaceRunBranchSourceLabel(item.currentIntent);
  const tooltipLabel = branchTooltipLabel(item);
  const [open, setOpen] = useState(false);
  // The popover's own content node, used to tell a nested overlay (stacked
  // above) from the host dialog (an ancestor) on outside-click - see
  // preserveWhenNestedOverlay.
  const contentRef = useRef<HTMLDivElement>(null);
  // Committing (Select/Enter) closes the popover, which would restore focus to
  // the chip — and the chip is also the branch tooltip's trigger, so the tooltip
  // would auto-open with the cursor away. Suppress the focus restoration on a
  // commit-close only (Escape / click-outside still restore focus normally).
  const suppressChipFocusRef = useRef(false);

  // Read-only branch label for every mode except an editable new worktree.
  // Derived from the intent kind, not `mode`: an adopted worktree (`import`) is
  // `mode: "worktree"` but its branch is fixed, so it must stay read-only.
  const location = folderLocationValue(item);
  if (location === "import") {
    const details = importedWorktreeBranchDetails(item);
    if (details === null) return <ReadonlyBranchLabel item={item} />;
    if (props.readOnly) {
      return (
        <ReadonlyBranchTrigger
          ariaLabel="View existing worktree branch"
          item={item}
          testId="folder-branch-import-trigger"
        />
      );
    }
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <TooltipWrapper
          label={tooltipLabel}
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="View existing worktree branch"
              data-testid="folder-branch-import-trigger"
              className={cn(FOLDER_CONTROL_TRIGGER_CLASS, "text-foreground/75")}
            >
              <GitBranch
                className="size-3.5 shrink-0 text-muted-foreground/65"
                aria-hidden
              />
              <WorkspaceBranchLabel
                target={item.branchLabel}
                source={null}
                className={undefined}
              />
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground/60" />
            </button>
          </PopoverTrigger>
        </TooltipWrapper>
        <PopoverContent
          ref={contentRef}
          side="bottom"
          align="start"
          collisionPadding={12}
          container={props.boundaryEl ?? undefined}
          className="w-[min(92vw,22rem)] gap-0 p-2.5"
          data-testid="folder-branch-popover"
          onInteractOutside={(event) =>
            preserveWhenNestedOverlay(event, contentRef.current)
          }
        >
          <ImportedWorktreeBranchForm
            sourceBranch={details.sourceBranch}
            currentBranchName={details.currentBranchName}
          />
        </PopoverContent>
      </Popover>
    );
  }

  if (location !== "worktree") {
    return <ReadonlyBranchLabel item={item} />;
  }

  const chip = (
    <button
      type="button"
      disabled={item.modeDisabled}
      aria-disabled={props.readOnly ? true : undefined}
      aria-label="Choose worktree branch"
      data-testid="folder-branch-trigger"
      className={cn(FOLDER_CONTROL_TRIGGER_CLASS, "text-foreground/75")}
    >
      <GitBranch
        className="size-3.5 shrink-0 text-muted-foreground/65"
        aria-hidden
      />
      <WorkspaceBranchLabel
        target={item.branchLabel}
        source={sourceLabel}
        className={undefined}
      />
      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground/60" />
    </button>
  );

  if (item.modeDisabled) {
    const disabledChip = <span className="inline-flex min-w-0">{chip}</span>;
    if (item.modeDisabledReason === null) return disabledChip;
    return (
      <TooltipWrapper
        label={item.modeDisabledReason}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        {disabledChip}
      </TooltipWrapper>
    );
  }

  if (props.readOnly) {
    return chip;
  }

  if (item.summary === null) {
    return (
      <TooltipWrapper
        label={tooltipLabel}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        {chip}
      </TooltipWrapper>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <TooltipWrapper
        label={tooltipLabel}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <PopoverTrigger asChild>{chip}</PopoverTrigger>
      </TooltipWrapper>
      <PopoverContent
        ref={contentRef}
        side="bottom"
        align="start"
        collisionPadding={12}
        container={props.boundaryEl ?? undefined}
        className="w-[min(92vw,22rem)] gap-0 p-2.5"
        data-testid="folder-branch-popover"
        onInteractOutside={(event) =>
          preserveWhenNestedOverlay(event, contentRef.current)
        }
        onCloseAutoFocus={(event) => {
          if (!suppressChipFocusRef.current) return;
          suppressChipFocusRef.current = false;
          event.preventDefault();
        }}
      >
        <NewWorktreeForm
          key={item.displayPath}
          hostClient={item.hostClient}
          workspacePath={item.displayPath}
          repoIdentifier={item.repoIdentifier}
          isPrimary={item.isPrimary}
          summary={item.summary}
          currentIntent={item.currentIntent}
          defaultNewBranchName={item.defaultNewBranchName}
          onEmit={item.onEmit}
          onCommitted={() => {
            suppressChipFocusRef.current = true;
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

function branchTooltipLabel(item: WorkspaceRunItem): string {
  const source = workspaceRunBranchSourceLabel(item.currentIntent);
  return source === null
    ? item.branchLabel
    : `${item.branchLabel} · from ${source}`;
}

function ReadonlyBranchTrigger(props: {
  readonly ariaLabel: string;
  readonly item: WorkspaceRunItem;
  readonly testId: string;
}) {
  return (
    <TooltipWrapper
      label={props.item.branchLabel}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <button
        type="button"
        aria-disabled
        aria-label={props.ariaLabel}
        data-testid={props.testId}
        className={cn(FOLDER_CONTROL_TRIGGER_CLASS, "text-foreground/75")}
      >
        <GitBranch
          className="size-3.5 shrink-0 text-muted-foreground/65"
          aria-hidden
        />
        <WorkspaceBranchLabel
          target={props.item.branchLabel}
          source={null}
          className={undefined}
        />
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground/60" />
      </button>
    </TooltipWrapper>
  );
}

function ReadonlyBranchLabel(props: { readonly item: WorkspaceRunItem }) {
  return (
    <TooltipWrapper
      label={props.item.branchLabel}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span
        className={cn(
          "inline-flex w-full max-w-full min-w-0 items-center gap-1.5 px-1.5 py-1 text-ui-sm text-foreground/75",
        )}
        data-testid="folder-branch-readonly"
      >
        <GitBranch
          className="size-3.5 shrink-0 text-muted-foreground/65"
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate">
          {props.item.branchLabel}
        </span>
      </span>
    </TooltipWrapper>
  );
}

function importedWorktreeBranchDetails(item: WorkspaceRunItem): {
  readonly sourceBranch: string;
  readonly currentBranchName: string;
} | null {
  const intent = item.currentIntent;
  if (intent?.kind !== "import" || item.summary === null) {
    return null;
  }
  const matching =
    item.summary.worktrees.find(
      (worktree) => worktree.worktreePath === intent.worktreePath,
    ) ?? null;
  const mainEntry = item.summary.worktrees.find((worktree) => worktree.isMain);
  return {
    sourceBranch:
      matching?.sourceBranch ??
      mainEntry?.branch ??
      item.summary.mainBranch ??
      "Unknown source",
    currentBranchName: matching?.branch ?? item.branchLabel,
  };
}
