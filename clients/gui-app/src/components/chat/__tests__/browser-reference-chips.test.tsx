import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/composer/landing-image-store", () => ({
  sessionObjectUrl: () => null,
  getImageBytes: () => Promise.resolve(undefined),
}));
import type { ReactNode } from "react";
import type { BrowserAnnotationRecord } from "@traycer/protocol/persistence/epic/schemas";
import { BrowserReferenceChips } from "@/components/chat/browser-reference-chips";
import { TooltipProvider } from "@/components/ui/tooltip";

function wrapper(node: ReactNode): ReactNode {
  return <TooltipProvider delayDuration={0}>{node}</TooltipProvider>;
}

afterEach(() => {
  cleanup();
});

describe("BrowserReferenceChips (ticket 08 disambiguation)", () => {
  it("renders nothing without annotations", () => {
    const { container } = render(
      wrapper(<BrowserReferenceChips annotations={[]} />),
    );
    expect(container.firstChild).toBeNull();
  });
});

function sentAnnotation(): BrowserAnnotationRecord {
  return {
    kind: "browser-annotation",
    annotationId: "ann-7f3a",
    tabId: "t-1",
    sessionId: "s-1",
    origin: "https://example.com",
    pageUrl: "https://example.com/",
    pageTitle: "Example Domain",
    capturedAt: 1_700_000_000_000,
    comment: "Make this hero section pop more",
    counts: { elements: 1, regions: 0, strokes: 0 },
    elements: [
      {
        selector: "main > h1",
        tagName: "h1",
        elementId: null,
        classNames: [],
        attributes: [],
        outerHtml: "<h1>Example Domain</h1>",
        outerHtmlTruncated: false,
        textPreview: "Example Domain",
        ariaRole: "heading",
        accessibleName: "Example Domain",
        boundingBox: {
          x: 60,
          y: 90,
          width: 420,
          height: 40,
          top: 90,
          right: 480,
          bottom: 130,
          left: 60,
        },
        computedStyles: [],
      },
    ],
    imageFileName: "browser-annotation-ann-7f3a.png",
    imageHash: "hash-ann-7f3a",
    droppedElementCount: 0,
  };
}

describe("BrowserReferenceChips sent annotation card", () => {
  it("renders a card keyed by annotationId with no remove button", () => {
    render(wrapper(<BrowserReferenceChips annotations={[sentAnnotation()]} />));

    const card = screen.getByTestId("browser-annotation-card");
    expect(card.getAttribute("data-annotation-id")).toBe("ann-7f3a");
    expect(screen.getByText("Make this hero section pop more")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Remove annotation" }),
    ).toBeNull();
  });
});
