import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface DiffContentLoadingSkeletonProps {
  readonly mode: "split" | "unified";
  readonly sizing: "fill" | "content";
  readonly density: "full" | "compact";
  readonly sectionIndex: number;
}

type DiffSkeletonRowKind = "context" | "delete" | "add" | "change";

interface DiffSkeletonRowSpec {
  readonly id: string;
  readonly kind: DiffSkeletonRowKind;
  readonly leftBlocks: readonly number[];
  readonly rightBlocks: readonly number[];
}

const SPLIT_ROWS: readonly DiffSkeletonRowSpec[] = [
  {
    id: "a-1",
    kind: "context",
    leftBlocks: [18, 24, 14],
    rightBlocks: [18, 24, 14],
  },
  { id: "a-2", kind: "context", leftBlocks: [12, 20], rightBlocks: [12, 20] },
  {
    id: "a-3",
    kind: "context",
    leftBlocks: [22, 16, 20],
    rightBlocks: [22, 16, 20],
  },
  { id: "a-4", kind: "delete", leftBlocks: [26, 18, 12], rightBlocks: [] },
  { id: "a-5", kind: "delete", leftBlocks: [14, 22], rightBlocks: [] },
  { id: "a-6", kind: "delete", leftBlocks: [20, 10, 16], rightBlocks: [] },
  { id: "a-7", kind: "add", leftBlocks: [], rightBlocks: [24, 14, 18] },
  { id: "a-8", kind: "add", leftBlocks: [], rightBlocks: [16, 22] },
  { id: "a-9", kind: "add", leftBlocks: [], rightBlocks: [20, 12, 14] },
  { id: "b-1", kind: "context", leftBlocks: [10, 18], rightBlocks: [10, 18] },
  { id: "b-2", kind: "change", leftBlocks: [14, 20], rightBlocks: [16, 18] },
  { id: "b-3", kind: "change", leftBlocks: [22, 12], rightBlocks: [20, 14] },
  { id: "b-4", kind: "delete", leftBlocks: [18, 8], rightBlocks: [] },
  { id: "b-5", kind: "add", leftBlocks: [], rightBlocks: [12, 16] },
  {
    id: "b-6",
    kind: "context",
    leftBlocks: [16, 22, 10],
    rightBlocks: [16, 22, 10],
  },
  { id: "b-7", kind: "context", leftBlocks: [8, 14], rightBlocks: [8, 14] },
];

const FIRST_HUNK_ROW_COUNT = 9;
const COMPACT_ROW_COUNT = 6;

const TONE_DELETE =
  "bg-[color-mix(in_srgb,var(--destructive)_20%,var(--background)_80%)]";
const TONE_ADD =
  "bg-[color-mix(in_srgb,var(--success)_20%,var(--background)_80%)]";
const TONE_NEUTRAL = "bg-background";

export function DiffContentLoadingSkeleton(
  props: DiffContentLoadingSkeletonProps,
): ReactNode {
  const fillsContainer = props.sizing === "fill";
  const isCompact = props.density === "compact";
  const compactStartIndex =
    (props.sectionIndex * 3) %
    Math.max(SPLIT_ROWS.length - COMPACT_ROW_COUNT, 1);
  const visibleRows = isCompact
    ? SPLIT_ROWS.slice(compactStartIndex, compactStartIndex + COMPACT_ROW_COUNT)
    : SPLIT_ROWS;
  const firstHunkRows = isCompact
    ? visibleRows
    : visibleRows.slice(0, FIRST_HUNK_ROW_COUNT);
  const secondHunkRows = isCompact
    ? []
    : visibleRows.slice(FIRST_HUNK_ROW_COUNT);

  return (
    <div
      aria-busy="true"
      aria-label="Loading diff"
      className={cn(
        "flex w-full flex-col bg-background",
        fillsContainer && "min-h-0 flex-1 overflow-hidden",
        !fillsContainer && isCompact && "shrink-0",
        !fillsContainer && !isCompact && "min-h-48 shrink-0",
      )}
      data-testid="diff-content-loading-skeleton"
    >
      <DiffSkeletonHunkHeader compact={isCompact} />
      <div
        className={cn(
          "flex w-full flex-col",
          fillsContainer && "min-h-0 flex-1",
        )}
      >
        <DiffSkeletonRows mode={props.mode} rows={firstHunkRows} />
        {secondHunkRows.length > 0 ? <DiffSkeletonHunkHeader compact /> : null}
        <DiffSkeletonRows mode={props.mode} rows={secondHunkRows} />
      </div>
    </div>
  );
}

function DiffSkeletonRows(props: {
  readonly mode: "split" | "unified";
  readonly rows: readonly DiffSkeletonRowSpec[];
}): ReactNode {
  return props.rows.map((row) => (
    <DiffSkeletonRow key={row.id} mode={props.mode} row={row} />
  ));
}

function DiffSkeletonHunkHeader(props: {
  readonly compact: boolean;
}): ReactNode {
  return (
    <div
      className={cn(
        "flex items-center border-b border-border/60 bg-muted/20 px-3",
        props.compact ? "h-6" : "h-7",
      )}
    >
      <Skeleton className="h-2.5 w-[min(42%,12rem)] rounded-sm" />
    </div>
  );
}

interface DiffSkeletonRowProps {
  readonly mode: "split" | "unified";
  readonly row: DiffSkeletonRowSpec;
}

function DiffSkeletonRow(props: DiffSkeletonRowProps): ReactNode {
  if (props.mode === "unified") {
    return (
      <div className="border-b border-border/40">
        <DiffSkeletonPane
          rowId={props.row.id}
          side="left"
          kind={props.row.kind}
          blocks={unifiedBlocks(props.row)}
          withLeadingBorder={undefined}
          unified
        />
      </div>
    );
  }

  return (
    <div className="grid w-full grid-cols-2 border-b border-border/40">
      <DiffSkeletonPane
        rowId={props.row.id}
        side="left"
        kind={props.row.kind}
        blocks={props.row.leftBlocks}
        withLeadingBorder={undefined}
        unified={undefined}
      />
      <DiffSkeletonPane
        rowId={props.row.id}
        side="right"
        kind={props.row.kind}
        blocks={props.row.rightBlocks}
        withLeadingBorder
        unified={undefined}
      />
    </div>
  );
}

function unifiedBlocks(row: DiffSkeletonRowSpec): readonly number[] {
  if (row.kind === "add") return row.rightBlocks;
  return row.leftBlocks;
}

interface DiffSkeletonPaneProps {
  readonly rowId: string;
  readonly side: "left" | "right";
  readonly kind: DiffSkeletonRowKind;
  readonly blocks: readonly number[];
  readonly withLeadingBorder: boolean | undefined;
  readonly unified: boolean | undefined;
}

function DiffSkeletonPane(props: DiffSkeletonPaneProps): ReactNode {
  return (
    <div
      className={cn(
        "flex h-[1.375rem] items-center px-2",
        resolvePaneTone(props.kind, props.side, props.unified === true),
        props.withLeadingBorder === true && "border-l border-border/40",
      )}
    >
      {props.blocks.length > 0 ? (
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          {props.blocks.map((widthCh) => (
            <div
              key={`${props.rowId}-${props.side}-${widthCh}`}
              className="h-2 shrink-0 rounded-sm bg-foreground/18"
              style={{ width: `${widthCh * 0.22}rem` }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function resolvePaneTone(
  kind: DiffSkeletonRowKind,
  side: "left" | "right",
  unified: boolean,
): string {
  if (kind === "context") return TONE_NEUTRAL;
  if (kind === "delete") {
    if (unified || side === "left") return TONE_DELETE;
    return TONE_NEUTRAL;
  }
  if (kind === "add") {
    if (unified || side === "right") return TONE_ADD;
    return TONE_NEUTRAL;
  }
  return side === "left" ? TONE_DELETE : TONE_ADD;
}
