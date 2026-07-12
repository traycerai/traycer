import {
  useLayoutEffect,
  useState,
  type ReactElement,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Folder } from "lucide-react";
import {
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
  size,
} from "@floating-ui/dom";

import { MaterialFileIcon } from "@/components/material-file-icon";
import type { MentionPreview } from "@/lib/composer/types";
import type { MentionPathTree } from "@/lib/path";
import { cn } from "@/lib/utils";

import { panelFitFor } from "./mention-preview-panel-fit";
import { ZERO_DOM_RECT } from "./zero-dom-rect";

const PANEL_GUTTER_PX = 6;
const PANEL_BOUNDARY_PADDING_PX = 8;
// The root row absorbs the full relative-path prefix as one string; past
// this many characters it stops fitting the panel's fixed width on one
// line, so it gets middle-elided instead of left to CSS tail-truncate.
const ROOT_LABEL_CHAR_BUDGET = 42;
// Tree rows never exceed 4 (root + up to 2 mid dirs + leaf) by construction
// of `mentionPathTree`'s hierarchy algorithm.
const TREE_ROW_INDENT_CLASSES = ["pl-0", "pl-4", "pl-8", "pl-12"] as const;

export interface MentionPreviewPanelProps {
  readonly panelRef: RefObject<HTMLDivElement | null>;
  readonly listRef: RefObject<HTMLDivElement | null>;
  readonly activeIndex: number;
  readonly preview: MentionPreview | null;
}

/**
 * Info-only preview panel pinned beside the composer's @mention/slash menu.
 * Anchored to the active row (via a floating-ui virtual reference reading
 * its live rect), so it tracks the highlighted row vertically as selection
 * changes. Placement prefers the right; `flip` falls back to the left; the
 * `size` gate hides the panel entirely once neither side has room, rather
 * than letting it render past the viewport edge or overlap the list.
 */
export function MentionPreviewPanel(props: MentionPreviewPanelProps) {
  const { panelRef, listRef, activeIndex, preview } = props;
  const [fits, setFits] = useState(false);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;

    // Scroll the active row into view before measuring/positioning below.
    // The menu's own scrollIntoView (composer-menu.tsx) runs in a *passive*
    // effect that fires after paint, while this positioning effect runs
    // before paint - on keyboard nav past the list's visible edge, that
    // ordering would otherwise measure the pre-scroll rect and paint one
    // frame at the stale spot before autoUpdate catches the scroll and
    // jumps. Doing it here settles scroll and position in the same
    // pre-paint pass. Keep the menu's own effect: it's still needed for
    // rows with no preview, where this component returns null below before
    // ever running. `block: "nearest"` no-ops once already visible, so the
    // duplicate scroll for preview rows is harmless.
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });

    const activeRowRect = (): DOMRect => {
      const list = listRef.current;
      const active =
        list?.querySelector<HTMLElement>('[data-active="true"]') ?? null;
      return active?.getBoundingClientRect() ?? ZERO_DOM_RECT;
    };
    const virtualReference = {
      getBoundingClientRect: activeRowRect,
      contextElement: listRef.current ?? undefined,
    };

    const reposition = (): void => {
      void computePosition(virtualReference, panel, {
        placement: "right-start",
        middleware: [
          offset(PANEL_GUTTER_PX),
          flip({
            fallbackPlacements: ["left-start"],
            padding: PANEL_BOUNDARY_PADDING_PX,
          }),
          shift({
            mainAxis: false,
            crossAxis: true,
            padding: PANEL_BOUNDARY_PADDING_PX,
          }),
          size({
            padding: PANEL_BOUNDARY_PADDING_PX,
            apply: ({ availableWidth, availableHeight, elements }) => {
              const fit = panelFitFor(availableWidth, availableHeight);
              setFits(fit.fits);
              elements.floating.style.maxWidth = `${fit.maxWidthPx}px`;
              elements.floating.style.maxHeight = `${fit.maxHeightPx}px`;
            },
          }),
        ],
      }).then(({ x, y }) => {
        panel.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(
          y,
        )}px, 0)`;
      });
    };

    reposition();
    return autoUpdate(virtualReference, panel, reposition);
  }, [panelRef, listRef, activeIndex, preview]);

  if (preview === null) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={panelRef}
      data-slot="mention-preview-panel"
      role="presentation"
      aria-hidden
      className={cn(
        "pointer-events-auto fixed top-0 left-0 z-50 flex w-[min(90vw,22rem)] flex-col overflow-hidden rounded-xl border border-border/70 bg-popover text-popover-foreground shadow-lg",
        !fits && "invisible",
      )}
    >
      <div
        data-slot="mention-preview-panel-scroll-area"
        className="min-h-0 max-h-[min(50vh,16rem)] overflow-y-auto overscroll-contain px-3 py-2"
      >
        <PreviewBody preview={preview} />
      </div>
    </div>,
    document.body,
  );
}

function PreviewBody(props: {
  readonly preview: MentionPreview;
}): ReactElement {
  const { preview } = props;
  switch (preview.kind) {
    case "text":
      return (
        <>
          <div
            className={cn(
              "min-w-0 text-ui-sm text-foreground",
              preview.mono && "font-mono wrap-anywhere",
            )}
          >
            {preview.primary}
          </div>
          {preview.secondary !== null ? (
            <div className="mt-1 min-w-0 text-ui-xs text-muted-foreground/70">
              {preview.secondary}
            </div>
          ) : null}
        </>
      );
    case "path":
      return (
        <>
          <PathTreeRows tree={preview.tree} />
          {preview.footer !== null ? (
            <div
              className={cn(
                "mt-1.5 min-w-0 text-ui-xs text-muted-foreground/70",
                preview.footer.mono && "font-mono wrap-anywhere",
              )}
            >
              {preview.footer.text}
            </div>
          ) : null}
        </>
      );
  }
}

interface PathTreeRow {
  readonly key: string;
  readonly label: string;
  readonly depth: number;
  readonly isLeaf: boolean;
}

function pathTreeRows(tree: MentionPathTree): ReadonlyArray<PathTreeRow> {
  const dirLabels = [
    middleElideRootLabel(tree.rootLabel),
    ...tree.midDirs,
  ].filter((label) => label.length > 0);
  const dirRows = dirLabels.map((label, depth) => ({
    key: `dir-${depth}`,
    label,
    depth,
    isLeaf: false,
  }));
  return [
    ...dirRows,
    { key: "leaf", label: tree.leaf, depth: dirRows.length, isLeaf: true },
  ];
}

function PathTreeRows(props: { readonly tree: MentionPathTree }): ReactElement {
  const { tree } = props;
  const rows = pathTreeRows(tree);
  return (
    <div className="min-w-0">
      {rows.map((row) => (
        <div
          key={row.key}
          className={cn(
            "flex min-w-0 items-center gap-1.5 py-0.5",
            TREE_ROW_INDENT_CLASSES[row.depth],
          )}
        >
          {row.isLeaf && tree.leafIsFile ? (
            <MaterialFileIcon
              filename={row.label}
              className="size-3.5 shrink-0"
            />
          ) : (
            <Folder
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-hidden
            />
          )}
          <span className="min-w-0 truncate text-ui-sm text-foreground">
            {row.label}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The root row absorbs the full relative prefix as one string, which can
 * overflow the panel's fixed width for deep trees. Elide the middle instead
 * of letting CSS truncate the tail, so the outermost root segment and the
 * deepest (nearest-to-leaf) directory - the two ends a reader orients from -
 * stay visible.
 */
function middleElideRootLabel(rootLabel: string): string {
  if (rootLabel.length <= ROOT_LABEL_CHAR_BUDGET) return rootLabel;
  const isAbsolute = rootLabel.startsWith("/");
  const segments = (isAbsolute ? rootLabel.slice(1) : rootLabel).split("/");
  if (segments.length <= 2) return rootLabel;
  const first = segments[0];
  const last = segments[segments.length - 1];
  return `${isAbsolute ? "/" : ""}${first}/…/${last}`;
}
