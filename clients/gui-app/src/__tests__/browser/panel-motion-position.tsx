import { type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { computePosition, offset } from "@floating-ui/dom";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { QuoteSelectionPopover } from "@/components/chat/quote/quote-selection-popover";
import type { QuoteSelectionSnapshot } from "@/components/chat/quote/use-quote-selection";
import "@/index.css";

const TRANSFORM_SLOTS = [
  "composer-menu",
  "mention-preview-panel",
  "artifact-link-popover",
  "floating-draft-popover",
  "thread-hover-popover",
  "mention-suggestion",
  "quote-selection-popover",
] as const;

interface SurfaceSnapshot {
  readonly rect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly transitionDuration: string;
  readonly transitionProperty: string;
  readonly animationDuration: string;
  readonly animationName: string;
}

interface PanelMotionProbe {
  readonly ready: boolean;
  readonly initialTransformSlots: Readonly<Record<string, SurfaceSnapshot>>;
  readonly initialSidecar: SurfaceSnapshot;
  readonly initialQuotePopover: {
    readonly surface: SurfaceSnapshot;
    readonly anchor: { readonly x: number; readonly y: number };
  } | null;
  moveTo(x: number, y: number): Promise<void>;
  snapshot(): {
    readonly anchor: { readonly x: number; readonly y: number };
    readonly transformSlots: Readonly<Record<string, SurfaceSnapshot>>;
    readonly sidecar: SurfaceSnapshot;
    readonly editorBubble: SurfaceSnapshot;
    readonly sheet: SurfaceSnapshot;
    readonly sidebar: SurfaceSnapshot;
    readonly drawer: SurfaceSnapshot;
    readonly radixPopover: {
      readonly content: SurfaceSnapshot;
      readonly wrapper: SurfaceSnapshot | null;
      readonly anchor: {
        readonly x: number;
        readonly y: number;
        readonly bottom: number;
      };
    };
    readonly quotePopover: {
      readonly surface: SurfaceSnapshot;
      readonly anchor: { readonly x: number; readonly y: number };
    };
  };
}

declare global {
  interface Window {
    __panelMotionProbe?: PanelMotionProbe;
  }
}

const host = document.createElement("div");
host.id = "quote-anchor";
host.className = "probe-quote-anchor";
const quoteText = "Selected quote text for live positioning";
host.textContent = quoteText;
document.body.append(host);
const quoteRange = document.createRange();
quoteRange.selectNodeContents(host);
window.getSelection()?.addRange(quoteRange);
const quoteSnapshot: QuoteSelectionSnapshot = {
  text: quoteText,
  fenceLanguage: null,
  range: quoteRange,
  root: host,
};
const noBoundary = { current: null };
let initialQuotePopover: PanelMotionProbe["initialQuotePopover"] = null;
const quotePlacementObserver = new MutationObserver(() => {
  if (initialQuotePopover !== null) return;
  const surface = document.querySelector(
    '[data-slot="quote-selection-popover"]',
  );
  if (
    !(surface instanceof HTMLElement) ||
    !surface.style.transform.startsWith("translate3d(")
  ) {
    return;
  }
  const rect =
    quoteRange.getClientRects().item(0) ?? quoteRange.getBoundingClientRect();
  initialQuotePopover = {
    surface: surfaceSnapshot(surface),
    anchor: { x: rect.x, y: rect.y },
  };
});
quotePlacementObserver.observe(document.body, {
  attributes: true,
  attributeFilter: ["style"],
  subtree: true,
});

export function Fixture(): ReactElement {
  return (
    <>
      {TRANSFORM_SLOTS.filter((slot) => slot !== "quote-selection-popover").map(
        (slot) => (
          <div
            key={slot}
            className="probe-floating"
            data-slot={slot}
            aria-hidden="true"
          />
        ),
      )}
      <div data-profile-usage-sidecar="" aria-hidden="true" />
      {/* Tiptap BubbleMenu owns this node's geometry; keep it as a CSS negative control. */}
      <div className="tc-editor-bubble-menu" aria-hidden="true" />
      <div
        className="probe-motion-surface transition duration-200"
        data-slot="sheet-content"
        style={{ transitionProperty: "transform" }}
      />
      <div
        className="probe-motion-surface transition-[width] duration-200"
        data-slot="sidebar-gap"
        style={{ transitionProperty: "width" }}
      />
      <div
        className="probe-motion-surface"
        data-slot="drawer-content"
        style={{ transitionProperty: "transform", transitionDuration: "200ms" }}
      />
      <Popover open>
        <PopoverTrigger className="probe-popover-anchor">
          Popover anchor
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={0}
        >
          Anchored Radix content
        </PopoverContent>
      </Popover>
      <QuoteSelectionPopover
        taskId="motion-regression"
        snapshot={quoteSnapshot}
        onDismiss={() => undefined}
        boundaryRef={noBoundary}
        bottomOverlayInsetPx={0}
      />
    </>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("Missing panel-motion fixture root");
createRoot(root).render(<Fixture />);

function surfaceSnapshot(element: Element | null): SurfaceSnapshot {
  if (!(element instanceof HTMLElement)) {
    throw new Error("A panel-motion fixture surface is missing");
  }
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return {
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    transitionDuration: style.transitionDuration,
    transitionProperty: style.transitionProperty,
    animationDuration: style.animationDuration,
    animationName: style.animationName,
  };
}

function positionSnapshot(): {
  readonly transformSlots: Readonly<Record<string, SurfaceSnapshot>>;
  readonly sidecar: SurfaceSnapshot;
} {
  return {
    transformSlots: Object.fromEntries(
      TRANSFORM_SLOTS.filter((slot) => slot !== "quote-selection-popover").map(
        (slot) => [slot, surfaceSnapshot(bySlot(slot))],
      ),
    ),
    sidecar: surfaceSnapshot(
      document.querySelector("[data-profile-usage-sidecar]"),
    ),
  };
}

function bySlot(slot: string): Element | null {
  return document.querySelector(`[data-slot="${slot}"]`);
}

function anchorRect(x: number, y: number): DOMRect {
  return new DOMRect(x, y, 80, 20);
}

async function positionCustomSurfaces(
  x: number,
  y: number,
): Promise<{
  readonly transformSlots: Readonly<Record<string, SurfaceSnapshot>>;
  readonly sidecar: SurfaceSnapshot;
}> {
  const reference = { getBoundingClientRect: () => anchorRect(x, y) };
  const transformSlots: Record<string, SurfaceSnapshot> = {};
  for (const slot of TRANSFORM_SLOTS) {
    if (slot === "quote-selection-popover") continue;
    const floating = bySlot(slot);
    if (!(floating instanceof HTMLElement)) throw new Error(`Missing ${slot}`);
    const { x: left, y: top } = await computePosition(reference, floating, {
      placement: "bottom-start",
      strategy: "fixed",
      middleware: [offset(4)],
    });
    Object.assign(floating.style, {
      position: "fixed",
      left: "0px",
      top: "0px",
      transform: `translate(${left}px, ${top}px)`,
    });
    transformSlots[slot] = surfaceSnapshot(floating);
  }
  const sidecar = document.querySelector<HTMLElement>(
    "[data-profile-usage-sidecar]",
  );
  if (sidecar === null) throw new Error("Missing profile usage sidecar");
  const { x: left, y: top } = await computePosition(reference, sidecar, {
    placement: "bottom-start",
    strategy: "fixed",
    middleware: [offset(4)],
  });
  Object.assign(sidecar.style, { left: `${left}px`, top: `${top}px` });
  return { transformSlots, sidecar: surfaceSnapshot(sidecar) };
}

async function waitForFixture(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      bySlot("popover-content") !== null &&
      bySlot("quote-selection-popover") !== null &&
      document.querySelector("[data-radix-popper-content-wrapper]") !== null
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out mounting the Radix and quote popovers");
}

await waitForFixture();
const initialPosition = await positionCustomSurfaces(120.5, 180.25);
let currentAnchor = { x: 120.5, y: 180.25 };

window.__panelMotionProbe = {
  get ready() {
    return true;
  },
  async moveTo(x, y) {
    const anchor = document.querySelector<HTMLElement>(".probe-popover-anchor");
    if (anchor === null) throw new Error("Missing Radix popover anchor");
    anchor.style.left = `${x}px`;
    anchor.style.top = `${y}px`;
    host.style.left = `${x}px`;
    host.style.top = `${y}px`;
    currentAnchor = { x, y };
    window.dispatchEvent(new Event("resize"));
    await positionCustomSurfaces(x, y);
  },
  snapshot() {
    const popoverAnchor = document.querySelector<HTMLElement>(
      ".probe-popover-anchor",
    );
    const popoverContent = bySlot("popover-content");
    const quotePopover = bySlot("quote-selection-popover");
    if (popoverAnchor === null || quotePopover === null) {
      throw new Error("A real popover fixture surface is missing");
    }
    const popoverAnchorRect = popoverAnchor.getBoundingClientRect();
    const quoteAnchorRect =
      quoteRange.getClientRects().item(0) ?? quoteRange.getBoundingClientRect();
    return {
      anchor: currentAnchor,
      ...positionSnapshot(),
      editorBubble: surfaceSnapshot(
        document.querySelector(".tc-editor-bubble-menu"),
      ),
      sheet: surfaceSnapshot(bySlot("sheet-content")),
      sidebar: surfaceSnapshot(bySlot("sidebar-gap")),
      drawer: surfaceSnapshot(bySlot("drawer-content")),
      radixPopover: {
        content: surfaceSnapshot(popoverContent),
        wrapper:
          document.querySelector("[data-radix-popper-content-wrapper]") === null
            ? null
            : surfaceSnapshot(
                document.querySelector("[data-radix-popper-content-wrapper]"),
              ),
        anchor: {
          x: popoverAnchorRect.x,
          y: popoverAnchorRect.y,
          bottom: popoverAnchorRect.bottom,
        },
      },
      quotePopover: {
        surface: surfaceSnapshot(quotePopover),
        anchor: { x: quoteAnchorRect.x, y: quoteAnchorRect.y },
      },
    };
  },
  initialTransformSlots: initialPosition.transformSlots,
  initialSidecar: initialPosition.sidecar,
  get initialQuotePopover() {
    return initialQuotePopover;
  },
};
