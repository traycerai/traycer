import { useLayoutEffect, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
} from "@floating-ui/dom";
import { TextQuote } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  appendQuoteToDraft,
  buildQuoteBlockquote,
} from "./append-quote-to-draft";
import { firstLineRect, firstVisibleLineRect } from "./quote-anchor-rect";
import type { QuoteSelectionSnapshot } from "./use-quote-selection";

interface QuoteSelectionPopoverProps {
  readonly taskId: string;
  readonly snapshot: QuoteSelectionSnapshot;
  readonly onDismiss: () => void;
  /** The scrollable transcript container: the popover is clipped to its bounds
   *  and rides the visible portion of a selection that scrolls past its start. */
  readonly boundaryRef: RefObject<HTMLElement | null>;
}

/**
 * The floating quote affordance above a validated selection. Deliberately a
 * MINIMAL non-modal portal: no `<dialog>`, no autofocus, no focus trap, no
 * focus restoration. Only the positioning idiom of `FloatingDraftPopover` is
 * reused (Floating UI `computePosition` + `autoUpdate`).
 *
 * Focus contract: mounting this must not change `document.activeElement`, and
 * the button's `mousedown` `preventDefault` keeps it from taking focus or
 * collapsing the selection. The composer focusing on quote (via
 * `appendQuoteToDraft` -> `replaceDraft(null)` -> `focus("end")`) is the only
 * focus mutation in the feature.
 */
export function QuoteSelectionPopover(props: QuoteSelectionPopoverProps) {
  const { taskId, snapshot, onDismiss, boundaryRef } = props;
  const floatingRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const floating = floatingRef.current;
    if (floating === null) return;
    const { range } = snapshot;

    // The rect Floating UI reads; recomputed each reposition to the first
    // visible selected line so the button rides the visible portion.
    let currentAnchor = range.getBoundingClientRect();
    const virtualReference = {
      // `contextElement` lets autoUpdate treat the transcript scroller (an
      // overflow ancestor of the root) as a scroll source, so scrolling the
      // transcript - not only the window - repositions the popover.
      contextElement: snapshot.root,
      getBoundingClientRect: () => currentAnchor,
    };

    const reposition = (): void => {
      // Anchor guard: the transcript is memoized + virtualized + streaming, so
      // the range's nodes can be replaced or unmounted while the popover is
      // open. Dismiss instead of repositioning to a garbage/corner position.
      // Liveness guard: while the setting was off no `selectionchange` listener
      // ran, so a snapshot can outlive its selection (off -> collapse -> on).
      if (!isRangeAnchored(range) || !isSelectionLiveInRoot(snapshot.root)) {
        onDismiss();
        return;
      }
      const container = boundaryRef.current;
      const anchor =
        container === null
          ? firstLineRect(range)
          : firstVisibleLineRect(range, container.getBoundingClientRect());
      if (anchor === null) {
        // Selection fully scrolled out of the transcript viewport: hide the
        // button but KEEP the snapshot so it returns when a line scrolls back.
        floating.style.visibility = "hidden";
        return;
      }
      currentAnchor = anchor;
      floating.style.visibility = "visible";
      const boundary = container ?? undefined;
      void computePosition(virtualReference, floating, {
        placement: "top-start",
        middleware: [
          offset(6),
          flip({ boundary, padding: 8 }),
          // Clamp within the transcript viewport on BOTH axes so the button
          // never renders over app chrome when the start scrolls above.
          shift({ boundary, crossAxis: true, padding: 8 }),
        ],
      }).then(({ x, y }) => {
        if (!floating.isConnected) return;
        floating.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
      });
    };
    reposition();
    return autoUpdate(virtualReference, floating, reposition);
  }, [snapshot, onDismiss, boundaryRef]);

  const handleQuote = (): void => {
    // Consume the mouseup snapshot; NEVER read the live Selection here.
    appendQuoteToDraft(
      taskId,
      buildQuoteBlockquote({
        text: snapshot.text,
        fenceLanguage: snapshot.fenceLanguage,
      }),
    );
    clearBrowserSelection();
    onDismiss();
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={floatingRef}
      data-slot="quote-selection-popover"
      // No entrance animation: `animate-in` runs the `enter` keyframe, whose
      // only `from` frame drives `transform` to the element's underlying value.
      // Since positioning here IS a `transform` (Floating UI, set below), the
      // keyframe animated the button diagonally from the `top-0 left-0` corner
      // to the anchor. The app's other floating popovers (FloatingDraftPopover,
      // MentionPreviewPanel) position with transform and add no entrance
      // animation for the same reason; match them.
      className="absolute top-0 left-0 z-50 rounded-md border border-border bg-popover p-0.5 text-popover-foreground shadow-lg"
    >
      <button
        type="button"
        // preventDefault keeps focus off the button and stops the browser from
        // collapsing the selection before the click fires; the quote action
        // runs on click. Its visible "Quote" label is the accessible name.
        onMouseDown={(event) => event.preventDefault()}
        onClick={handleQuote}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-sm px-2 py-1",
          "text-xs font-medium text-popover-foreground transition-colors",
          "hover:bg-accent hover:text-accent-foreground",
          "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
        )}
      >
        <TextQuote className="size-3.5" aria-hidden />
        Quote
      </button>
    </div>,
    document.body,
  );
}

function isRangeAnchored(range: Range): boolean {
  if (!range.startContainer.isConnected || !range.endContainer.isConnected) {
    return false;
  }
  const rect = range.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}

// The live selection must still be non-collapsed and start inside the quotable
// root the snapshot came from. Comparing the start (not the end) tolerates the
// triple-click clamp, whose end intentionally sits past the root.
function isSelectionLiveInRoot(root: Element): boolean {
  const selection = window.getSelection();
  if (
    selection === null ||
    selection.isCollapsed ||
    selection.rangeCount === 0
  ) {
    return false;
  }
  return root.contains(selection.getRangeAt(0).startContainer);
}

function clearBrowserSelection(): void {
  const selection = window.getSelection();
  if (selection === null) return;
  selection.removeAllRanges();
}
