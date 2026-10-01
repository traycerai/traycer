/**
 * The one zoom cluster every zoomable surface renders - image tile, image
 * diff, Mermaid and SVG viewer, PDF and Word preview - so a zoom reads the
 * same way everywhere:
 *
 *   [ - ] [ 137% ] [ + ]  |  [ fit ] [ 1:1 ]
 *
 * The percentage is a READOUT and nothing else. It follows every zoom the
 * surface makes, pinch and wheel included, and pressing it does nothing.
 * The two anchors after the divider are the actions: fit (to the stage, or
 * to a page's width on a paged document) and actual size, which is one
 * content pixel per CSS pixel. Before this cluster existed the image viewer
 * labelled its actual-size action "100%", which read as a zoom level that
 * never moved - the confusion this file replaces.
 *
 * Keyboard shortcuts live on the buttons themselves, so they work whenever
 * the cluster has focus: `+`/`-` step, `0` actual size, `F` fit.
 */
import type { KeyboardEvent, ReactNode } from "react";
import { Maximize2, Minus, Plus, Scan } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";
import { fitLabel } from "./fit-label";

/** What a surface knows about its own zoom; the cluster renders it verbatim. */
export interface ZoomControlsModel {
  /** `false` while there is nothing to zoom yet - every control disables. */
  readonly ready: boolean;
  /** The live zoom, already rounded; `null` until the surface has measured one. */
  readonly scalePercent: number | null;
  readonly canZoomIn: boolean;
  readonly canZoomOut: boolean;
  readonly onZoomIn: () => void;
  readonly onZoomOut: () => void;
  /**
   * `"screen"` fits the whole content into the stage (an image, a diagram);
   * `"width"` fits one page's width, which is the useful fit on a paged
   * document that scrolls vertically.
   */
  readonly fitKind: "screen" | "width";
  readonly fitActive: boolean;
  readonly onFit: () => void;
  readonly actualSizeActive: boolean;
  readonly onActualSize: () => void;
}

export interface ZoomControlsProps extends ZoomControlsModel {
  /** Extra classes on the step group (zoom out, readout, zoom in) - a container query that folds it away, typically. */
  readonly stepGroupClassName: string | undefined;
  /** Extra classes on the divider and the anchor group (fit, actual size). */
  readonly anchorGroupClassName: string | undefined;
}

/** The actual-size mark, shared by the button and the document toolbar's overflow menu so the action looks the same in both. */
export function ActualSizeGlyph(): ReactNode {
  return (
    <span aria-hidden="true" className="text-ui-xs font-semibold tabular-nums">
      1:1
    </span>
  );
}

export function ZoomControls(props: ZoomControlsProps): ReactNode {
  const zoomOutDisabled = !props.ready || !props.canZoomOut;
  const zoomInDisabled = !props.ready || !props.canZoomIn;

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      if (!zoomInDisabled) props.onZoomIn();
      return;
    }
    if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      if (!zoomOutDisabled) props.onZoomOut();
      return;
    }
    if (event.key === "0") {
      event.preventDefault();
      if (props.ready) props.onActualSize();
      return;
    }
    if (event.key === "f" || event.key === "F") {
      event.preventDefault();
      if (props.ready) props.onFit();
    }
  }

  const FitIcon = props.fitKind === "screen" ? Maximize2 : Scan;

  return (
    <>
      <div className={cn("flex items-center gap-1", props.stepGroupClassName)}>
        <TooltipWrapper
          label="Zoom out (-)"
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={zoomOutDisabled}
            onClick={props.onZoomOut}
            onKeyDown={handleKeyDown}
            aria-label="Zoom out"
            aria-keyshortcuts="-"
          >
            <Minus className="size-4" />
          </Button>
        </TooltipWrapper>
        <span
          // A status region: it gives the readout a valid accessible name
          // (a generic span may not carry one) and announces zoom changes
          // politely, so a keyboard or screen-reader zoom is confirmed.
          role="status"
          aria-label="Zoom level"
          className="min-w-9 whitespace-nowrap text-center text-ui-xs font-medium tabular-nums"
        >
          {props.scalePercent === null ? "–" : `${props.scalePercent}%`}
        </span>
        <TooltipWrapper
          label="Zoom in (+)"
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={zoomInDisabled}
            onClick={props.onZoomIn}
            onKeyDown={handleKeyDown}
            aria-label="Zoom in"
            aria-keyshortcuts="+"
          >
            <Plus className="size-4" />
          </Button>
        </TooltipWrapper>
      </div>
      <div
        className={cn("mx-0.5 h-4 w-px bg-border", props.anchorGroupClassName)}
        aria-hidden="true"
      />
      <div
        className={cn("flex items-center gap-1", props.anchorGroupClassName)}
      >
        <TooltipWrapper
          label={`${fitLabel(props.fitKind)} (F)`}
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-pressed={props.fitActive}
            disabled={!props.ready}
            onClick={props.onFit}
            onKeyDown={handleKeyDown}
            aria-label={fitLabel(props.fitKind)}
            aria-keyshortcuts="F"
          >
            <FitIcon className="size-4" />
          </Button>
        </TooltipWrapper>
        <TooltipWrapper
          label="Actual size (0)"
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-pressed={props.actualSizeActive}
            disabled={!props.ready}
            onClick={props.onActualSize}
            onKeyDown={handleKeyDown}
            aria-label="Actual size"
            aria-keyshortcuts="0"
          >
            <ActualSizeGlyph />
          </Button>
        </TooltipWrapper>
      </div>
    </>
  );
}
