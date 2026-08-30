import { Check, ChevronRight, FolderX, Minus } from "lucide-react";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";
import { useCompactRelativeTime } from "@/lib/relative-time";
import type {
  SessionImportGroupSelectionState,
  SessionImportGroupView,
  SessionImportRowView,
} from "@/components/session-import/session-import-model";
import type { SessionImportTone } from "@/components/session-import/session-import-tone";

const MISSING_FOLDER_HINT =
  "This folder no longer exists - this work imports without a workspace.";

/**
 * Checkbox visual with no interactive element of its own: the row around it is
 * the control (`role="checkbox"`), so the whole row is the hit target and
 * nothing nests a button inside a button. Exported for the wizard's
 * master checkbox, which heads the same column these boxes form.
 */
export function SelectionBox(props: {
  readonly state: SessionImportGroupSelectionState;
  readonly disabled: boolean;
  readonly tone: SessionImportTone;
}) {
  const { state, disabled, tone } = props;
  const filled = state !== "none";
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-sm border transition-colors",
        filled ? tone.checkboxFilled : cn("border-current/40", tone.faint),
        disabled && "opacity-40",
      )}
    >
      {state === "all" ? <Check className="size-3" /> : null}
      {state === "partial" ? <Minus className="size-3" /> : null}
    </span>
  );
}

/**
 * Its own component so the shared 60s clock behind `useCompactRelativeTime`
 * repaints just this label, instead of waking every row it ticks under.
 */
function SessionRowTimestamp(props: {
  readonly updatedAt: number;
  readonly tone: SessionImportTone;
}) {
  const { updatedAt, tone } = props;
  const when = useCompactRelativeTime(updatedAt);
  return (
    <span
      className={cn(
        "min-w-10 shrink-0 truncate text-right text-ui-xs",
        tone.faint,
      )}
    >
      {when}
    </span>
  );
}

/**
 * One number, not a fraction: a fully picked folder reads as its count alone.
 * "All" counts what is actually submitted (the selectable rows), because
 * unavailable rows never import; an untouched or cleared folder shows
 * everything it holds.
 */
function groupCountLabel(group: SessionImportGroupView): string {
  if (group.selectionState === "partial") {
    return `${group.selectedCount.toLocaleString()} of ${group.selectableCount.toLocaleString()}`;
  }
  if (group.selectionState === "all") {
    return group.selectableCount.toLocaleString();
  }
  return group.totalCount.toLocaleString();
}

function SessionRow(props: {
  readonly row: SessionImportRowView;
  readonly tone: SessionImportTone;
  readonly onToggle: (selectionKey: string) => void;
}) {
  const { row, tone, onToggle } = props;
  const { candidate } = row;

  return (
    <TooltipWrapper
      label={row.unavailableDetail}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={row.selected}
        // `aria-disabled`, never the `disabled` attribute: a disabled button
        // emits no pointer events, so the tooltip explaining WHY the row is
        // unavailable could never open - which is the only explanation the
        // user gets.
        aria-disabled={!row.selectable}
        aria-label={row.title}
        data-testid="session-import-row"
        data-selectable={row.selectable}
        onClick={() => {
          if (row.selectable) onToggle(row.selectionKey);
        }}
        // px-1.5 under the list's own p-1 lands this checkbox on the group
        // header's 10px left edge; the chevron up there and the harness icon
        // here then share a column, and the titles start flush with each other.
        className={cn(
          "flex w-full min-w-0 items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
          row.selectable ? tone.rowHover : "cursor-default",
          !row.selectable && "opacity-55",
        )}
      >
        <SelectionBox
          state={row.selected ? "all" : "none"}
          disabled={!row.selectable}
          tone={tone}
        />
        <HarnessIcon
          harnessId={candidate.harness}
          className={cn("size-3.5", tone.muted)}
        />
        <span className={cn("min-w-0 flex-1 truncate text-ui-sm", tone.strong)}>
          {row.title}
        </span>
        {row.unavailableLabel !== null ? (
          <span className={cn("shrink-0 text-ui-xs", tone.faint)}>
            {row.unavailableLabel}
          </span>
        ) : null}
        <SessionRowTimestamp updatedAt={candidate.updatedAt} tone={tone} />
      </button>
    </TooltipWrapper>
  );
}

export function SessionImportGroupItem(props: {
  readonly group: SessionImportGroupView;
  readonly tone: SessionImportTone;
  readonly onToggleExpanded: (groupKey: string) => void;
  readonly onSetGroupSelection: (groupKey: string, selected: boolean) => void;
  readonly onToggleSession: (selectionKey: string) => void;
}) {
  const {
    group,
    tone,
    onToggleExpanded,
    onSetGroupSelection,
    onToggleSession,
  } = props;

  return (
    <div
      data-testid="session-import-group"
      data-group-key={group.groupKey}
      // shrink-0 is load-bearing: overflow-hidden drops a flex item's automatic
      // minimum size to zero, so inside the wizard's scrolling column every
      // card would compress to a sliver (many groups) or swallow its own rows
      // (one tall group) instead of making the column overflow and scroll.
      className={cn("shrink-0 overflow-hidden rounded-lg border", tone.border)}
    >
      <div
        className={cn("flex w-full min-w-0 items-center", tone.groupSurface)}
      >
        <button
          type="button"
          role="checkbox"
          aria-checked={
            group.selectionState === "partial"
              ? "mixed"
              : group.selectionState === "all"
          }
          aria-label={`Select all work in ${group.name}`}
          disabled={group.selectableCount === 0}
          data-testid="session-import-group-select"
          onClick={() =>
            onSetGroupSelection(group.groupKey, group.selectionState !== "all")
          }
          // ring-inset on both header controls: the card clips at its rounded
          // border, so an outset ring would render cut off. p-2.5 all round
          // keeps this checkbox on the same left edge - and the same distance
          // from what follows it - as the row checkboxes below (4px list
          // padding + 6px row padding = the same 10px).
          className={cn(
            "flex shrink-0 items-center rounded-md p-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
            group.selectableCount > 0 && tone.rowHover,
          )}
        >
          <SelectionBox
            state={group.selectionState}
            disabled={group.selectableCount === 0}
            tone={tone}
          />
        </button>
        <button
          type="button"
          aria-expanded={group.expanded}
          data-testid="session-import-group-toggle"
          onClick={() => onToggleExpanded(group.groupKey)}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2.5 py-2.5 pr-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
            tone.rowHover,
          )}
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 transition-transform",
              tone.faint,
              group.expanded && "rotate-90",
            )}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  "min-w-0 truncate text-ui-sm font-medium",
                  tone.strong,
                )}
              >
                {group.name}
              </span>
              {group.missingFolder ? (
                <TooltipWrapper
                  label={MISSING_FOLDER_HINT}
                  side="top"
                  sideOffset={undefined}
                  align={undefined}
                >
                  <span
                    data-testid="session-import-missing-folder"
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-ui-xs",
                      tone.warningSurface,
                    )}
                  >
                    <FolderX aria-hidden className="size-3" />
                    Folder not found
                  </span>
                </TooltipWrapper>
              ) : null}
            </span>
            <span className={cn("min-w-0 truncate text-ui-xs", tone.faint)}>
              {group.path}
            </span>
          </span>
          {/*
            One number, not a fraction: a folder the user has not touched is
            fully picked, so "431 of 431" is noise on every row. The fraction
            appears exactly when it says something - the folder is half in.
          */}
          <span
            data-testid="session-import-group-count"
            className={cn("shrink-0 text-ui-xs tabular-nums", tone.muted)}
          >
            {groupCountLabel(group)}
          </span>
        </button>
      </div>
      {group.expanded ? (
        <div className={cn("flex flex-col gap-0.5 border-t p-1", tone.border)}>
          {group.rows.map((row) => (
            <SessionRow
              key={row.selectionKey}
              row={row}
              tone={tone}
              onToggle={onToggleSession}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
