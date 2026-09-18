import { Check, ChevronRight, CircleCheck, Folder, Minus } from "lucide-react";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { SessionImportOpenTaskButton } from "@/components/session-import/session-import-open-task-button";
import { cn } from "@/lib/utils";
import { getBasename } from "@/lib/path/cross-platform-path";
import { useCompactRelativeTime } from "@/lib/relative-time";
import { importedCountNoun } from "@/components/session-import/session-import-model";
import type {
  SessionImportGroupSelectionState,
  SessionImportGroupView,
  SessionImportRowView,
} from "@/components/session-import/session-import-model";
import type { SessionImportTone } from "@/components/session-import/session-import-tone";

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
      className={cn("shrink-0 text-right text-ui-xs tabular-nums", tone.faint)}
    >
      {when}
    </span>
  );
}

/** Selection detail is available without making the folder count change meaning. */
function groupSelectionLabel(group: SessionImportGroupView): string {
  const count = group.selectableCount.toLocaleString();
  const noun = importedCountNoun(group.selectableCount);
  if (group.selectionState === "none")
    return `${count} ${noun} available to import`;
  if (group.selectionState === "all") return `All ${count} ${noun} selected`;
  return `${group.selectedCount.toLocaleString()} of ${count} ${noun} selected`;
}

/**
 * The count on the right edge of a tour group header. "All imported" is
 * derived from the rows rather than from `selectableCount === 0`, which a
 * folder of unreadable sessions also satisfies - and "n sessions" is the
 * honest answer there.
 */
function groupCountLabel(group: SessionImportGroupView): string {
  if (group.selectableCount > 0)
    return `${group.selectedCount} of ${group.selectableCount} selected`;
  const allImported =
    group.rows.length > 0 &&
    group.rows.every(
      (row) => row.candidate.state.kind === "already_in_traycer",
    );
  if (allImported) return "All imported";
  return `${group.totalCount} ${importedCountNoun(group.totalCount)}`;
}

/** A row whose task is already in Traycer: no checkbox, a way to open it. */
function ImportedTaskRow(props: {
  readonly row: SessionImportRowView;
  readonly state: Extract<
    SessionImportRowView["candidate"]["state"],
    { kind: "already_in_traycer" }
  >;
  readonly tone: SessionImportTone;
  readonly showFolder: boolean;
  readonly onTaskOpened: () => void;
  readonly onBeforeTaskOpen: (() => Promise<boolean>) | null;
}) {
  const { row, state, tone, showFolder, onTaskOpened } = props;
  const { candidate } = row;
  const onboarding = tone.surface === "onboarding";
  return (
    <div
      data-testid="session-import-row"
      data-selectable={false}
      data-imported="true"
      className={cn(
        "flex w-full min-w-0 items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left",
        onboarding && "onboarding-import-task",
      )}
    >
      {/* The tour's card says what this row IS with a glyph in the column
          the checkbox occupies on every other row; the dialog keeps that
          column empty so its rows stay a single flat list. */}
      {onboarding ? (
        <CircleCheck
          aria-hidden
          className="size-4 shrink-0 text-success-foreground"
        />
      ) : (
        <span aria-hidden className="size-4 shrink-0" />
      )}
      <HarnessIcon
        harnessId={candidate.harness}
        className={cn("size-3.5 opacity-75", tone.muted)}
      />
      <SessionImportTaskLabel row={row} tone={tone} showFolder={showFolder} />
      <span
        className={cn(
          "shrink-0 text-ui-xs",
          tone.muted,
          // A pill on a tinted card is a badge on a badge; the tour's row is
          // already the whole statement.
          !onboarding && "rounded bg-foreground/8 px-1.5 py-0.5",
        )}
      >
        Imported
      </span>
      <SessionImportOpenTaskButton
        targetHostId={null}
        presentation="icon"
        target={state}
        title={row.title}
        onTaskOpened={onTaskOpened}
        onBeforeTaskOpen={props.onBeforeTaskOpen}
      />
      {onboarding ? null : (
        <SessionRowTimestamp updatedAt={candidate.updatedAt} tone={tone} />
      )}
    </div>
  );
}

export function SessionImportTaskRow(props: {
  readonly row: SessionImportRowView;
  readonly tone: SessionImportTone;
  /** Show folder context when rows are not under a named folder header. */
  readonly showFolder: boolean;
  readonly onToggle: (selectionKey: string) => void;
  readonly onTaskOpened: () => void;
  readonly onBeforeTaskOpen: (() => Promise<boolean>) | null;
}) {
  const { row, tone, showFolder, onToggle, onTaskOpened } = props;
  const { candidate } = row;
  const onboarding = tone.surface === "onboarding";

  if (candidate.state.kind === "already_in_traycer")
    return (
      <ImportedTaskRow
        row={row}
        state={candidate.state}
        tone={tone}
        showFolder={showFolder}
        onTaskOpened={onTaskOpened}
        onBeforeTaskOpen={props.onBeforeTaskOpen}
      />
    );

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
        aria-label={
          showFolder || onboarding
            ? `${row.title} in ${row.folderPath}`
            : row.title
        }
        data-testid="session-import-row"
        data-selectable={row.selectable}
        onClick={() => {
          if (row.selectable) onToggle(row.selectionKey);
        }}
        className={cn(
          "flex w-full min-w-0 items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
          // The tour's rows own their hover in `onboarding-import.css`, where
          // the selected state's stronger tint can beat it.
          onboarding && "onboarding-import-task",
          !row.selectable && "cursor-default",
          row.selectable && !onboarding && tone.rowHover,
          !row.selectable && (onboarding ? "opacity-50" : "opacity-55"),
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
        <SessionImportTaskLabel row={row} tone={tone} showFolder={showFolder} />
        {row.unavailableLabel !== null ? (
          <span className={cn("shrink-0 text-ui-xs", tone.faint)}>
            {row.unavailableLabel}
          </span>
        ) : null}
        {onboarding ? null : (
          <SessionRowTimestamp updatedAt={candidate.updatedAt} tone={tone} />
        )}
      </button>
    </TooltipWrapper>
  );
}

function SessionImportTaskLabel(props: {
  readonly row: SessionImportRowView;
  readonly tone: SessionImportTone;
  readonly showFolder: boolean;
}) {
  const { row, tone, showFolder } = props;
  const onboarding = tone.surface === "onboarding";
  const folderLabel = onboarding ? getBasename(row.folderPath) : row.folderPath;
  const titleClass = cn(
    "min-w-0 truncate text-ui-sm",
    onboarding && "font-medium",
    tone.strong,
  );
  const folder = showFolder ? (
    <TooltipWrapper
      label={onboarding ? row.folderPath : null}
      side="top"
      sideOffset={6}
      align="start"
    >
      <span
        data-testid="session-import-row-folder"
        className={cn("min-w-0 truncate text-ui-xs", tone.faint)}
      >
        {folderLabel}
      </span>
    </TooltipWrapper>
  ) : null;
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className={titleClass}>{row.title}</span>
      {/* One 12px line under the title carries every scrap of context the tour's
          card has room for: which folder it ran in, and how long ago. The
          dialog keeps the timestamp in its own right-hand column. */}
      {onboarding ? (
        <span className="flex min-w-0 items-baseline gap-1.5">
          {folder}
          {folder === null ? null : (
            <span aria-hidden className={tone.faint}>
              ·
            </span>
          )}
          <SessionRowTimestamp
            updatedAt={row.candidate.updatedAt}
            tone={tone}
          />
        </span>
      ) : (
        folder
      )}
    </span>
  );
}

export function SessionImportGroupItem(props: {
  readonly group: SessionImportGroupView;
  readonly tone: SessionImportTone;
  readonly onToggleExpanded: (groupKey: string) => void;
  readonly onSetGroupSelection: (groupKey: string, selected: boolean) => void;
  readonly onToggleSession: (selectionKey: string) => void;
  readonly onTaskOpened: () => void;
  readonly onBeforeTaskOpen: (() => Promise<boolean>) | null;
}) {
  const {
    group,
    tone,
    onToggleExpanded,
    onSetGroupSelection,
    onToggleSession,
  } = props;

  const rows = group.rows.map((row) => (
    <SessionImportTaskRow
      key={row.selectionKey}
      row={row}
      tone={tone}
      showFolder={group.missingFolder}
      onToggle={onToggleSession}
      onTaskOpened={props.onTaskOpened}
      onBeforeTaskOpen={props.onBeforeTaskOpen}
    />
  ));

  if (tone.surface === "onboarding") {
    return (
      <section
        data-testid="session-import-group"
        data-group-key={group.groupKey}
        className="onboarding-import-group min-w-0"
      >
        <div className="onboarding-import-group-header flex items-center gap-2">
          <button
            type="button"
            role="checkbox"
            aria-checked={
              group.selectionState === "partial"
                ? "mixed"
                : group.selectionState === "all"
            }
            aria-label={`${group.name}: ${groupSelectionLabel(group)}`}
            disabled={group.selectableCount === 0}
            onClick={() =>
              onSetGroupSelection(
                group.groupKey,
                group.selectionState !== "all",
              )
            }
            className="flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-foreground/6 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
          >
            <SelectionBox
              state={group.selectionState}
              disabled={group.selectableCount === 0}
              tone={tone}
            />
          </button>
          <Folder
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <TooltipWrapper
            label={group.path}
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            <h2 className="min-w-0 truncate text-ui-sm font-medium">
              {group.name}
            </h2>
          </TooltipWrapper>
          <span className="ml-auto shrink-0 text-ui-xs tabular-nums text-muted-foreground">
            {groupCountLabel(group)}
          </span>
        </div>
        <div className="onboarding-import-list">{rows}</div>
      </section>
    );
  }

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
        {group.selectableCount > 0 ? (
          <TooltipWrapper
            label={groupSelectionLabel(group)}
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            <button
              type="button"
              role="checkbox"
              aria-checked={
                group.selectionState === "partial"
                  ? "mixed"
                  : group.selectionState === "all"
              }
              aria-label={`${group.name}: ${groupSelectionLabel(group)}`}
              disabled={group.selectableCount === 0}
              data-testid="session-import-group-select"
              onClick={() =>
                onSetGroupSelection(
                  group.groupKey,
                  group.selectionState !== "all",
                )
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
          </TooltipWrapper>
        ) : (
          <span aria-hidden className="size-4 shrink-0 mx-2.5" />
        )}
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
              "size-3.5 shrink-0",
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
            </span>
            <span className={cn("min-w-0 truncate text-ui-xs", tone.faint)}>
              {group.path}
            </span>
          </span>
          <span
            data-testid="session-import-group-count"
            className={cn("shrink-0 text-ui-xs tabular-nums", tone.muted)}
          >
            {group.totalCount.toLocaleString()}
          </span>
        </button>
      </div>
      {group.expanded ? (
        <div className={cn("flex flex-col gap-0.5 border-t p-1", tone.border)}>
          {rows}
        </div>
      ) : null}
    </div>
  );
}
