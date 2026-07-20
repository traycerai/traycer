import { useState, type ButtonHTMLAttributes, type Ref } from "react";
import { ChevronDown, TriangleAlert } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { HoverPreviewCard } from "@/components/ui/hover-preview-card";
import { cn } from "@/lib/utils";
import { WorkspaceFolderHoverList } from "./workspace-folder-hover-list";
import { WorkspaceFolderRows } from "./workspace-folder-rows";
import { WorkspaceModeIcon } from "./workspace-mode-icon";
import {
  workspaceRunBranchSourceLabel,
  type WorkspaceRunItem,
} from "./workspace-run-item";
import { WorkspaceBranchLabel } from "./workspace-branch-label";

const NOOP = (): void => undefined;
const NOOP_ADD = (): Promise<boolean> => Promise.resolve(false);

/**
 * In-epic collapsed summary: `📁 folder · branch (+N)` from `items[0]`, the mode
 * glyph, and a missing indicator. Interactive (opens the folder-rows popover)
 * unless `readOnly`, where hover keeps the compact preview and click opens an
 * inspect-only folder list with no binding controls.
 */
export function WorkspaceSummaryTrigger(
  props: ButtonHTMLAttributes<HTMLButtonElement> & {
    readonly items: ReadonlyArray<WorkspaceRunItem>;
    readonly readOnly: boolean;
    readonly bindingResolved: boolean;
    readonly ref?: Ref<HTMLButtonElement>;
  },
) {
  const { items, readOnly, bindingResolved, className, ref, ...rest } = props;
  // Resolve by the marked `isPrimary` row, not array order: the host
  // normalizes binding flags without reordering entries, so the collapsed
  // chip must agree with the primary pin/row rather than always reading
  // position 0.
  const primary =
    items.length === 0
      ? null
      : (items.find((item) => item.isPrimary) ?? items[0]);
  const extraCount = Math.max(0, items.length - 1);
  const anyMissing = items.some((item) => item.missing);
  const [readOnlyPopoverOpen, setReadOnlyPopoverOpen] = useState(false);
  const [readOnlyHoverOpen, setReadOnlyHoverOpen] = useState(false);

  const triggerButton = (
    <button
      type="button"
      ref={ref}
      data-testid="workspace-summary-trigger"
      aria-disabled={readOnly && items.length === 0 ? true : undefined}
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-2 rounded-md px-1.5 py-1 text-ui-sm text-muted-foreground opacity-70 transition-[background-color,opacity] hover:bg-accent/50 hover:opacity-100 focus-visible:opacity-100",
        readOnly &&
          items.length === 0 &&
          "cursor-default hover:bg-transparent hover:opacity-70",
        className,
      )}
      {...rest}
    >
      {primary === null ? (
        <SummaryEmptyState bindingResolved={bindingResolved} />
      ) : (
        <>
          {anyMissing ? (
            <TriangleAlert
              className="size-3.5 shrink-0 text-destructive"
              aria-hidden
              data-testid="workspace-summary-missing"
            />
          ) : null}
          <WorkspaceModeIcon mode={primary.mode} />
          <span className="min-w-0 max-w-[min(30vw,11rem)] truncate">
            {primary.displayName}
          </span>
          <span className="shrink-0 text-lg leading-none text-current/70">
            ·
          </span>
          <span className="flex min-w-0 max-w-[min(44vw,18rem)] flex-1">
            <WorkspaceBranchLabel
              target={primary.branchLabel}
              source={workspaceRunBranchSourceLabel(primary.currentIntent)}
              className={undefined}
            />
          </span>
          {extraCount > 0 ? (
            <span className="shrink-0 rounded-md bg-muted/80 px-1.5 py-0.5 text-overline font-medium text-current">
              +{extraCount}
            </span>
          ) : null}
        </>
      )}
      <ChevronDown className="size-3.5 shrink-0 text-current" />
    </button>
  );
  // The interactive (non-read-only) summary is wrapped by the parent's
  // controlled hover card (`WorkspaceFolderSummaryControl`), which gates the
  // preview on the click-open picker; the read-only branch below owns its own
  // coordinated hover+popover pair.
  const trigger = triggerButton;

  // Read-only (terminal-agent): hover keeps the compact preview; click expands
  // the normal folder rows with every binding control suppressed.
  if (readOnly) {
    if (items.length === 0) return trigger;
    return (
      <Popover
        open={readOnlyPopoverOpen}
        onOpenChange={(nextOpen) => {
          setReadOnlyPopoverOpen(nextOpen);
          if (nextOpen) setReadOnlyHoverOpen(false);
        }}
      >
        <HoverPreviewCard
          content={<WorkspaceFolderHoverList items={items} />}
          side="bottom"
          sideOffset={4}
          align="start"
          open={!readOnlyPopoverOpen && readOnlyHoverOpen}
          onOpenChange={(nextOpen) => {
            if (readOnlyPopoverOpen) return;
            setReadOnlyHoverOpen(nextOpen);
          }}
        >
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        </HoverPreviewCard>
        <PopoverContent
          side="bottom"
          align="start"
          collisionPadding={12}
          className="w-[min(92vw,42rem)] max-w-[var(--radix-popover-content-available-width)] max-h-[min(var(--radix-popover-content-available-height),32rem)] gap-0 overflow-y-auto p-3"
          data-testid="workspace-readonly-folders-popover"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <WorkspaceFolderRows
            items={items}
            trailingSlot={null}
            addFolderPending={false}
            addFolderDisabled
            addFolderDisabledReason={null}
            onAddFolder={NOOP_ADD}
            onUpdate={null}
            updateEnabled={false}
            updatePending={false}
            onEditEnvironment={NOOP}
            readOnly
            nestedInPopover={false}
            bindingResolved={bindingResolved}
          />
        </PopoverContent>
      </Popover>
    );
  }

  return trigger;
}

function SummaryEmptyState(props: { readonly bindingResolved: boolean }) {
  if (props.bindingResolved) {
    return <span className="text-current/70">No workspace linked</span>;
  }
  return (
    <>
      <AgentSpinningDots
        className="size-4 shrink-0 text-current"
        testId={undefined}
        variant="dots"
      />
      <span className="text-current/70">Linking workspace…</span>
    </>
  );
}
