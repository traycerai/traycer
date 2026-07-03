import { useState, type ReactNode } from "react";
import { FileDiff, GripVertical } from "lucide-react";
import type { DraggableSyntheticListeners } from "@dnd-kit/core";
import { v4 as uuidv4 } from "uuid";
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import type { ArtifactOperationAction } from "@traycer/protocol/persistence/epic/content-blocks";
import { StaticEpicNodeIcon } from "@/components/epic-canvas/epic-node-tab-icon";
import { STATUS_LABELS } from "@/components/epic-canvas/sidebar/epic-sidebar-tree-shared";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { EPIC_NODE_LABELS } from "@/lib/artifacts/node-display";
import {
  useArtifactById,
  useEpicDeletedArtifact,
  useOpenEpicId,
} from "@/lib/epic-selectors";
import { artifactDiffRenderable } from "@/lib/chat/artifact-diff-renderable";
import { artifactOperationVerb } from "@/lib/chat/artifact-operation-verb";
import { cn } from "@/lib/utils";
import type { ArtifactSegmentChange } from "@/stores/composer/chat-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useChatArtifactDragSource } from "@/components/epic-canvas/dnd/use-chat-artifact-drag-source";
import { OpenFullDiffControl } from "./open-full-diff-control";
import { SnapshotHashInlineDiff } from "./snapshot-hash-inline-diff";

interface ArtifactCardSegmentProps {
  readonly operation: ArtifactOperationAction;
  readonly artifactKind: EpicArtifactKind;
  readonly artifactId: string;
  readonly title: string | null;
  // The turn's merged change for this artifact, or null while streaming / when
  // uncaptured. When present, a file-diff toggle appears in the header and opens
  // the merged diff flush-connected below the card.
  readonly change: ArtifactSegmentChange | null;
  readonly findUnitId: string | null;
}

/**
 * File-diff toggle shown in the header, just left of the operation badge. A
 * real button, sibling to the open-artifact button, so the header has valid
 * interactive markup. Opens / closes the merged diff connected below the card.
 */
function ArtifactDiffToggle(props: {
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const label = props.open ? "Hide diff" : "View diff";
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={props.open}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        props.onToggle();
      }}
      className={cn(
        "flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md border transition-colors",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
        props.open
          ? "border-border bg-muted/60 text-foreground"
          : "border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground",
      )}
    >
      <FileDiff aria-hidden className="size-3.5" />
    </button>
  );
}

/**
 * The card's header row, and the drag surface for the card. The open-artifact
 * action is a child button, while the diff toggle and full-diff control are
 * siblings, avoiding nested interactive content. Drag lives on this whole row
 * (never the outer card) so an expanded diff body below stays free for text
 * selection, and the whole row shows the grab cursor on hover. The overlay chip
 * is centered on the pointer by the root DragOverlay's `snapCenterToCursor`
 * modifier, so a full-width row does not leave the chip offset from the hand.
 *
 * A `GripVertical` fades in on hover to signal draggability. It lives in a
 * reserved IN-FLOW column (never absolutely positioned), so it can never overlap
 * the artifact icon, and it is `pointer-events-none` decoration - the row, not
 * the grip, is the drag node. The column is reserved even for a non-draggable
 * card (rendered empty) so icons stay aligned across a mixed list.
 *
 * Only `setNodeRef` + `listeners` are attached: the row wraps a real open
 * button, so spreading dnd-kit's default `attributes` (which set `role="button"`
 * + `tabIndex` on this div) would nest interactive/focusable elements, and the
 * root DnD system ships no keyboard sensor. The card stays keyboard-openable via
 * its inner buttons.
 */
function ArtifactCardHeaderRow(props: {
  readonly sticky: boolean;
  readonly surfaceClassName: string;
  readonly stickySurfaceClassName: string;
  readonly hoverClassName: string | null;
  readonly dragRef: (element: HTMLElement | null) => void;
  readonly dragListeners: DraggableSyntheticListeners;
  readonly draggable: boolean;
  readonly isDragging: boolean;
  readonly children: ReactNode;
}) {
  const {
    sticky,
    surfaceClassName,
    stickySurfaceClassName,
    hoverClassName,
    dragRef,
    dragListeners,
    draggable,
    isDragging,
    children,
  } = props;
  const className = cn(
    "flex w-full items-center gap-2 px-2.5 py-2 text-left",
    sticky ? stickySurfaceClassName : surfaceClassName,
    !sticky && hoverClassName,
    sticky && "sticky top-0 z-20 border-b border-border/40 shadow-sm",
    draggable && (isDragging ? "cursor-grabbing" : "cursor-grab"),
  );
  return (
    <div ref={dragRef} className={className} {...dragListeners}>
      <span
        aria-hidden
        className="flex w-4 shrink-0 items-center justify-center"
      >
        {draggable ? (
          <GripVertical
            className={cn(
              "pointer-events-none size-3.5 text-muted-foreground/45 transition-opacity",
              isDragging
                ? "opacity-100"
                : "opacity-0 group-hover/artifact-card:opacity-100",
            )}
          />
        ) : null}
      </span>
      {children}
    </div>
  );
}

const ARTIFACT_KIND_CARD_CLASSES: Readonly<Record<EpicArtifactKind, string>> = {
  spec: "border-amber-400/45 border-l-2 shadow-sm shadow-amber-950/5 dark:border-amber-300/45",
  ticket:
    "border-violet-400/45 border-l-2 shadow-sm shadow-violet-950/5 dark:border-violet-300/45",
  story:
    "border-emerald-400/45 border-l-2 shadow-sm shadow-emerald-950/5 dark:border-emerald-300/45",
  review:
    "border-rose-400/45 border-l-2 shadow-sm shadow-rose-950/5 dark:border-rose-300/45",
};

const ARTIFACT_KIND_SURFACE_CLASSES: Readonly<
  Record<EpicArtifactKind, string>
> = {
  spec: "bg-amber-400/[0.07] dark:bg-amber-300/[0.08]",
  ticket: "bg-violet-400/[0.07] dark:bg-violet-300/[0.08]",
  story: "bg-emerald-400/[0.07] dark:bg-emerald-300/[0.08]",
  review: "bg-rose-400/[0.07] dark:bg-rose-300/[0.08]",
};

// Opaque equivalent of the collapsed card's surface, for the sticky header. A
// sticky header floats over the scrolling diff, so a translucent tint lets the
// diff rows bleed through - it must be opaque. The collapsed card applies the
// kind tint TWICE (the outer card AND the header each carry
// ARTIFACT_KIND_SURFACE_CLASSES), so the visible color is the tint composited
// over itself: 1-(1-0.07)^2 = 13.5% light, 1-(1-0.08)^2 = 15.4% dark. These mix
// that exact effective weight into an opaque `--background` so the expanded
// header keeps the collapsed card's color. The mix is `in srgb` - NOT `in oklch`
// - because Tailwind's `bg-<hue>/[a]` is an sRGB alpha-composite, so an `in srgb`
// color-mix is the exact opaque match.
const ARTIFACT_KIND_STICKY_SURFACE_CLASSES: Readonly<
  Record<EpicArtifactKind, string>
> = {
  spec: "bg-[color-mix(in_srgb,var(--background)_86.5%,var(--color-amber-400))] dark:bg-[color-mix(in_srgb,var(--background)_84.6%,var(--color-amber-300))]",
  ticket:
    "bg-[color-mix(in_srgb,var(--background)_86.5%,var(--color-violet-400))] dark:bg-[color-mix(in_srgb,var(--background)_84.6%,var(--color-violet-300))]",
  story:
    "bg-[color-mix(in_srgb,var(--background)_86.5%,var(--color-emerald-400))] dark:bg-[color-mix(in_srgb,var(--background)_84.6%,var(--color-emerald-300))]",
  review:
    "bg-[color-mix(in_srgb,var(--background)_86.5%,var(--color-rose-400))] dark:bg-[color-mix(in_srgb,var(--background)_84.6%,var(--color-rose-300))]",
};

const ARTIFACT_KIND_ICON_CLASSES: Readonly<Record<EpicArtifactKind, string>> = {
  spec: "border-amber-400/25 bg-amber-400/10 text-amber-700 dark:border-amber-300/25 dark:bg-amber-300/10 dark:text-amber-300",
  ticket:
    "border-violet-400/25 bg-violet-400/10 text-violet-700 dark:border-violet-300/25 dark:bg-violet-300/10 dark:text-violet-300",
  story:
    "border-emerald-400/25 bg-emerald-400/10 text-emerald-700 dark:border-emerald-300/25 dark:bg-emerald-300/10 dark:text-emerald-300",
  review:
    "border-rose-400/25 bg-rose-400/10 text-rose-700 dark:border-rose-300/25 dark:bg-rose-300/10 dark:text-rose-300",
};

const ARTIFACT_KIND_HOVER_CLASSES: Readonly<Record<EpicArtifactKind, string>> =
  {
    spec: "group-hover/artifact-card:bg-amber-400/[0.11]",
    ticket: "group-hover/artifact-card:bg-violet-400/[0.11]",
    story: "group-hover/artifact-card:bg-emerald-400/[0.11]",
    review: "group-hover/artifact-card:bg-rose-400/[0.11]",
  };

/**
 * Operation glyph ported from the old VS Code webview
 * `operation-status-indicator`: create→`+` (green), update→dot (amber),
 * delete→`−` (red). A fixed 20px badge - an inherently-sized chrome element,
 * so the literal `size-*` is intentional (not a layout surface).
 */
function ArtifactOperationBadge(props: {
  readonly operation: ArtifactOperationAction;
}) {
  const base =
    "flex size-5 shrink-0 items-center justify-center rounded-md border text-ui-base font-semibold leading-none shadow-sm";
  const label = artifactOperationVerb(props.operation);
  if (props.operation === "create") {
    return (
      <span
        className={cn(
          base,
          "border-emerald-500 bg-emerald-50 text-emerald-600 dark:border-emerald-400 dark:bg-emerald-950/60 dark:text-emerald-300",
        )}
        title={label}
      >
        <span className="sr-only">{label}</span>
        <span aria-hidden>+</span>
      </span>
    );
  }
  if (props.operation === "update") {
    return (
      <span
        className={cn(
          base,
          "border-amber-500 bg-amber-50 shadow-amber-950/5 dark:border-amber-400 dark:bg-amber-950/60",
        )}
        title={label}
      >
        <span className="sr-only">{label}</span>
        <span
          className="size-1.5 rounded-sm bg-amber-500 dark:bg-amber-300"
          aria-hidden
        />
      </span>
    );
  }
  return (
    <span
      className={cn(
        base,
        "border-red-500 bg-red-50 text-red-600 dark:border-red-500 dark:bg-red-950/60 dark:text-red-300",
      )}
      title={label}
    >
      <span className="sr-only">{label}</span>
      <span aria-hidden>−</span>
    </span>
  );
}

function ArtifactKindIconTile(props: {
  readonly displayKind: EpicArtifactKind;
}) {
  return (
    <span
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-md border",
        ARTIFACT_KIND_ICON_CLASSES[props.displayKind],
      )}
      aria-hidden
    >
      <StaticEpicNodeIcon type={props.displayKind} className="size-3.5" />
    </span>
  );
}

/**
 * Secondary kind + status line shown below the title.
 * Tickets additionally show their live status: "Ticket · In Progress".
 * Other kinds show just the short kind label: "Spec", "Story", "Review".
 */
function ArtifactKindMeta(props: {
  readonly displayKind: EpicArtifactKind;
  readonly status: number | null;
}) {
  const kindLabel = EPIC_NODE_LABELS[props.displayKind];
  const statusLabel =
    props.displayKind === "ticket" && props.status !== null
      ? (STATUS_LABELS[props.status] ?? null)
      : null;
  return (
    <span className="truncate text-ui-xs text-muted-foreground">
      {statusLabel !== null ? `${kindLabel} · ${statusLabel}` : kindLabel}
    </span>
  );
}

function ArtifactSummaryControl(props: {
  readonly canOpen: boolean;
  readonly openTitle: string;
  readonly onOpen: () => void;
  readonly displayKind: EpicArtifactKind;
  readonly title: string | null;
  readonly isDeleted: boolean;
  readonly status: number | null;
}) {
  const content = (
    <>
      <ArtifactKindIconTile displayKind={props.displayKind} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <ArtifactTitle
          title={props.title}
          displayKind={props.displayKind}
          isDeleted={props.isDeleted}
        />
        <ArtifactKindMeta
          displayKind={props.displayKind}
          status={props.status}
        />
      </span>
    </>
  );
  const className = cn(
    "flex min-w-0 flex-1 items-center gap-2.5 text-left",
    "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
    props.canOpen && "cursor-pointer",
  );
  if (props.canOpen) {
    return (
      <button
        type="button"
        onClick={props.onOpen}
        aria-label={`Open ${props.openTitle}`}
        className={className}
      >
        {content}
      </button>
    );
  }
  return <span className={className}>{content}</span>;
}

function ArtifactDiffControls(props: {
  readonly hasDiff: boolean;
  readonly diffOpen: boolean;
  readonly onToggleDiff: () => void;
  readonly change: ArtifactSegmentChange | null;
  readonly openTitle: string;
}) {
  return (
    <>
      {props.hasDiff ? (
        <ArtifactDiffToggle
          open={props.diffOpen}
          onToggle={props.onToggleDiff}
        />
      ) : null}
      {props.diffOpen && props.change !== null ? (
        <OpenFullDiffControl
          filePath="index.md"
          beforeHash={props.change.beforeHash}
          afterHash={props.change.afterHash}
          title={props.openTitle}
        />
      ) : null}
    </>
  );
}

function resolveArtifactTitle(
  projectionTitle: string | null,
  fallbackTitle: string | null,
): string | null {
  if (projectionTitle !== null && projectionTitle.length > 0) {
    return projectionTitle;
  }
  if (fallbackTitle !== null && fallbackTitle.length > 0) {
    return fallbackTitle;
  }
  return null;
}

function ArtifactTitle(props: {
  readonly title: string | null;
  readonly displayKind: EpicArtifactKind;
  readonly isDeleted: boolean;
}) {
  if (props.title === null) {
    return (
      <span className="min-w-0 flex-1 truncate text-ui-sm text-muted-foreground/70 italic">
        {EPIC_NODE_LABELS[props.displayKind]}
      </span>
    );
  }
  return (
    <span
      className={cn(
        "min-w-0 flex-1 truncate text-ui-base font-semibold text-foreground/95",
        props.isDeleted && "text-muted-foreground line-through",
      )}
      title={props.isDeleted ? "This artifact was deleted." : undefined}
    >
      {props.title}
    </span>
  );
}

function isUnavailableDeletedArtifact(input: {
  readonly hasLiveArtifact: boolean;
  readonly hasTombstone: boolean;
  readonly title: string | null;
}): boolean {
  return !input.hasLiveArtifact && !input.hasTombstone && input.title !== null;
}

function isArtifactCardDeleted(input: {
  readonly operation: ArtifactOperationAction;
  readonly hasTombstone: boolean;
  readonly unavailableWithTitle: boolean;
}): boolean {
  return (
    input.operation === "delete" ||
    input.hasTombstone ||
    input.unavailableWithTitle
  );
}

function canOpenArtifactCard(input: {
  readonly isDeleted: boolean;
  readonly hasLiveArtifact: boolean;
  readonly hasHost: boolean;
}): boolean {
  return input.hasLiveArtifact && input.hasHost && !input.isDeleted;
}

/**
 * Lighter single-row card for one artifact create / update / delete (no group
 * header / count). Resolution is REACTIVE: the live title / ticket status comes
 * from `artifacts.byId[artifactId]` and the deletion tombstone from
 * `deletedArtifacts.byId[artifactId]`, both subscribed - so a just-minted or
 * cross-host-synced id that is absent at first render fills in (pending →
 * resolved) without a remount, and a later rename/status-change/delete reflects
 * live. The whole card opens the artifact in the epic's canvas (a tombstone has
 * no body, so a deleted card is not openable).
 */
export function ArtifactCardSegment(props: ArtifactCardSegmentProps) {
  return (
    <ArtifactCardSegmentContent
      key={artifactCardDiffStateKey(props)}
      {...props}
    />
  );
}

function artifactCardDiffStateKey(props: ArtifactCardSegmentProps): string {
  if (
    props.change === null ||
    !artifactDiffRenderable({
      operation: props.operation,
      beforeHash: props.change.beforeHash,
      afterHash: props.change.afterHash,
    })
  ) {
    return "no-diff";
  }
  return `${props.change.beforeHash ?? "null"}:${props.change.afterHash ?? "null"}`;
}

function ArtifactCardSegmentContent(props: ArtifactCardSegmentProps) {
  const { operation, artifactKind, artifactId } = props;
  const live = useArtifactById(artifactId);
  const tombstone = useEpicDeletedArtifact(artifactId);
  const epicId = useOpenEpicId();
  const activeHostId = useReactiveActiveHostId();
  const [diffOpen, setDiffOpen] = useState(false);

  // Prefer the tombstone for a delete (the live entry is already gone); else the
  // live projection. Both null ⇒ pending/unavailable - render a graceful
  // placeholder; the subscription fills it in when the id syncs.
  const resolved = tombstone ?? live;
  const displayKind: EpicArtifactKind = resolved?.kind ?? artifactKind;
  const projectionTitle = resolved === null ? null : resolved.title;
  const title = resolveArtifactTitle(projectionTitle, props.title);
  const hasLiveArtifact = live !== null;
  const hasTombstone = tombstone !== null;
  const unavailableWithTitle = isUnavailableDeletedArtifact({
    hasLiveArtifact,
    hasTombstone,
    title,
  });
  // A delete can race tombstone projection, and older history may point at an
  // artifact that no longer exists. If the artifact is already unavailable and
  // we still have a title, show the missing/deleted title treatment while
  // preserving the card's original operation badge.
  const isDeleted = isArtifactCardDeleted({
    operation,
    hasTombstone,
    unavailableWithTitle,
  });
  const status = isDeleted ? null : (resolved?.status ?? null);
  const openTitle = title ?? EPIC_NODE_LABELS[displayKind];

  // Only a live artifact can open in the canvas; a tombstone has no body, and a
  // not-yet-resolved id has no host binding target.
  const canOpen = canOpenArtifactCard({
    isDeleted,
    hasLiveArtifact,
    hasHost: activeHostId !== null,
  });

  // Drag source (mirrors the sidebar): the card opens its artifact in the
  // canvas. Identity is present only when a host is bound (`activeHostId`);
  // `enabled` reuses the `canOpen` gate (live artifact + host + not deleted).
  // The shared hook owns the pure `viewTabId` resolution (C1), the
  // occurrence-unique drag id (C3), and the identity-only payload (C2). The card
  // attaches `setNodeRef` + `listeners` to the whole header row (no
  // `attributes`).
  const {
    isDraggable: canDrag,
    setNodeRef: dragRef,
    listeners: dragListeners,
    isDragging,
  } = useChatArtifactDragSource({
    epicId,
    identity:
      activeHostId === null
        ? null
        : {
            id: artifactId,
            type: displayKind,
            name: openTitle,
            hostId: activeHostId,
          },
    enabled: canOpen,
  });

  const openArtifact = (): void => {
    // Re-check the raw conditions so the host id narrows to a non-null string.
    if (isDeleted || live === null || activeHostId === null) return;
    const canvas = useEpicCanvasStore.getState();
    const tabId = canvas.resolveTargetTabForEpic(epicId, undefined);
    canvas.openTileInTab(tabId, {
      id: artifactId,
      instanceId: uuidv4(),
      type: displayKind,
      name: openTitle,
      hostId: activeHostId,
    });
  };

  const change = props.change;
  const hasDiff =
    change !== null &&
    artifactDiffRenderable({
      operation,
      beforeHash: change.beforeHash,
      afterHash: change.afterHash,
    });
  const toggleDiff = (): void => {
    if (!hasDiff) return;
    setDiffOpen((prev) => !prev);
  };

  const header = (
    <>
      <ArtifactSummaryControl
        canOpen={canOpen}
        openTitle={openTitle}
        onOpen={openArtifact}
        displayKind={displayKind}
        title={title}
        isDeleted={isDeleted}
        status={status}
      />
      <ArtifactDiffControls
        hasDiff={hasDiff}
        diffOpen={diffOpen}
        onToggleDiff={toggleDiff}
        change={change}
        openTitle={openTitle}
      />
      <ArtifactOperationBadge operation={operation} />
    </>
  );

  // The title/icon region opens the artifact (when openable); the diff controls
  // are sibling buttons in the same header row. The diff body is a sibling row
  // INSIDE the same bordered container, so it reads as one connected card (no
  // gap). When open, the header sticks while the main chat scrolls, matching
  // file-change cards with large diffs.
  return (
    <div
      data-chat-find-unit={props.findUnitId ?? undefined}
      className={cn(
        "group/artifact-card rounded-md border text-ui-sm transition-colors",
        ARTIFACT_KIND_CARD_CLASSES[displayKind],
        ARTIFACT_KIND_SURFACE_CLASSES[displayKind],
      )}
    >
      <ArtifactCardHeaderRow
        sticky={diffOpen}
        surfaceClassName={ARTIFACT_KIND_SURFACE_CLASSES[displayKind]}
        stickySurfaceClassName={
          ARTIFACT_KIND_STICKY_SURFACE_CLASSES[displayKind]
        }
        hoverClassName={
          canOpen ? ARTIFACT_KIND_HOVER_CLASSES[displayKind] : null
        }
        dragRef={dragRef}
        dragListeners={dragListeners}
        draggable={canDrag}
        isDragging={isDragging}
      >
        {header}
      </ArtifactCardHeaderRow>
      {diffOpen && change !== null ? (
        <div className="px-2.5 py-2.5">
          <SnapshotHashInlineDiff
            filePath="index.md"
            beforeHash={change.beforeHash}
            afterHash={change.afterHash}
            cacheScope={`artifact-card:${artifactId}`}
          />
        </div>
      ) : null}
    </div>
  );
}
