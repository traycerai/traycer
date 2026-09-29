import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AppColumnFrame,
  type AppColumnFrameProps,
} from "@/components/layout/app-column-frame";
import type { AppColumnChrome } from "@/components/layout/header/app-title-band-kind";
import { SheetJoinScope } from "@/components/layout/tabs/sheet-join";
import { usePublishSheetJoin } from "@/components/layout/tabs/sheet-join-context";
import type { SheetJoinPane } from "@/components/layout/tabs/side-strip/side-tab-join";

const TOP: AppColumnChrome = { placement: "top", titleBand: "header" };
const LEFT_NONE: AppColumnChrome = { placement: "left", titleBand: "none" };
const RIGHT_BAND: AppColumnChrome = { placement: "right", titleBand: "band" };

/** A stand-in for a joined tab: publishes `pane` while on; a click toggles it. */
function TogglePublisher(props: {
  readonly id: string;
  readonly pane: SheetJoinPane;
}): ReactNode {
  const [on, setOn] = useState(true);
  usePublishSheetJoin(on ? props.pane : null);
  return (
    <button
      type="button"
      data-testid={`join-toggle-${props.id}`}
      onClick={() => setOn((current) => !current)}
    />
  );
}

function renderFrame(chrome: AppColumnChrome): HTMLElement {
  return renderFrameWith(chrome, null);
}

/** The frame inside a join scope (the app's own lives in `RootDndProvider`). */
function renderFrameWith(
  chrome: AppColumnChrome,
  beside: ReactNode,
): HTMLElement {
  const props: AppColumnFrameProps = {
    ...chrome,
    columnRef: () => undefined,
    header: <header data-testid="header-slot" />,
    strip: <nav data-testid="strip-slot" />,
    banners: <div data-testid="banners-slot" />,
    surface: <div data-testid="surface-slot" />,
    mainTail: <div data-testid="main-tail-slot" />,
    tail: (
      <>
        <div data-testid="tail-first" />
        <div data-testid="tail-last" />
      </>
    ),
  };
  const { container } = render(
    <SheetJoinScope>
      <AppColumnFrame {...props} />
      {beside}
    </SheetJoinScope>,
  );
  const column = container.querySelector<HTMLElement>("[data-layout-column]");
  if (column === null) throw new Error("column not rendered");
  return column;
}

function surfaceFrame(): HTMLElement {
  const parent = screen.getByTestId("surface-slot").parentElement;
  if (parent === null) throw new Error("surface frame not rendered");
  return parent;
}

function precedes(a: Element, b: Element): boolean {
  return (
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  );
}

describe("AppColumnFrame", () => {
  afterEach(() => {
    cleanup();
  });

  it("draws the header and no strip for top, framed at the top", () => {
    const column = renderFrame(TOP);

    expect(screen.getByTestId("header-slot")).not.toBeNull();
    expect(screen.queryByTestId("strip-slot")).toBeNull();
    expect(screen.queryByTestId("app-title-band")).toBeNull();
    expect(surfaceFrame().classList.contains("md:task-surface-frame")).toBe(
      true,
    );
    expect(column.firstElementChild).toBe(screen.getByTestId("header-slot"));
  });

  it("puts a left strip before <main>, and still frames the surface plainly", () => {
    renderFrame(LEFT_NONE);

    const strip = screen.getByTestId("strip-slot");
    const main = screen.getByRole("main");
    expect(precedes(strip, main)).toBe(true);
    expect(strip.nextElementSibling?.contains(main)).toBe(true);
    // The beside-left/beside-right utilities are gone: every placement gets
    // the same plain `task-surface-frame`.
    expect(surfaceFrame().classList.contains("md:task-surface-frame")).toBe(
      true,
    );
  });

  it("puts a right strip after <main>, and still frames the surface plainly", () => {
    renderFrame(RIGHT_BAND);

    const strip = screen.getByTestId("strip-slot");
    const main = screen.getByRole("main");
    expect(precedes(main, strip)).toBe(true);
    expect(strip.previousElementSibling?.contains(main)).toBe(true);
    expect(surfaceFrame().classList.contains("md:task-surface-frame")).toBe(
      true,
    );
  });

  it("draws the title band and no header for band", () => {
    const column = renderFrame(RIGHT_BAND);

    expect(screen.getByTestId("app-title-band")).not.toBeNull();
    expect(screen.queryByTestId("header-slot")).toBeNull();
    expect(column.firstElementChild).toBe(screen.getByTestId("app-title-band"));
  });

  it("draws neither header nor band for none", () => {
    renderFrame(LEFT_NONE);

    expect(screen.queryByTestId("app-title-band")).toBeNull();
    expect(screen.queryByTestId("header-slot")).toBeNull();
  });

  it.each([TOP, LEFT_NONE, RIGHT_BAND])(
    "keeps the banners above <main> in the content column for $placement",
    (chrome) => {
      renderFrame(chrome);

      const banners = screen.getByTestId("banners-slot");
      const main = screen.getByRole("main");
      expect(banners.parentElement).toBe(main.parentElement);
      expect(banners.nextElementSibling).toBe(main);
      expect(main.lastElementChild).toBe(screen.getByTestId("main-tail-slot"));
    },
  );

  it.each([TOP, LEFT_NONE, RIGHT_BAND])(
    "nests the content beside the strip and paints the shell ground for $placement",
    (chrome) => {
      const column = renderFrame(chrome);

      const main = screen.getByRole("main");
      const content = main.parentElement;
      const row = content?.parentElement;
      if (content === null || row === null || row === undefined) {
        throw new Error("frame boxes not rendered");
      }
      expect(row.parentElement).toBe(column);
      expect(
        [...row.children].filter(
          (child) => child !== screen.queryByTestId("strip-slot"),
        ),
      ).toEqual([content]);

      // Ticket 02 (D1/D2): the column paints the ground the header (top
      // placement) and the side strip go transparent on, so it has to span
      // every placement, not just the beside ones.
      expect(column.classList.contains("md:bg-shell-ground")).toBe(true);
    },
  );

  it.each([TOP, LEFT_NONE, RIGHT_BAND])(
    "stamps the placement on the column and the band kind on the document root for $placement / $titleBand, and keeps the tail's last child last",
    (chrome) => {
      const column = renderFrame(chrome);

      expect(column.dataset.tabStripPlacement).toBe(chrome.placement);
      expect(document.documentElement.dataset.appTitleBand).toBe(
        chrome.titleBand,
      );
      expect(column.hasAttribute("data-swipe-nav-screen")).toBe(true);
      expect(column.lastElementChild).toBe(screen.getByTestId("tail-last"));
    },
  );

  it.each([TOP, LEFT_NONE, RIGHT_BAND])(
    "publishes $titleBand on the document root for the portalled overlays, and clears it on unmount",
    (chrome) => {
      renderFrame(chrome);

      expect(document.documentElement.getAttribute("data-app-title-band")).toBe(
        chrome.titleBand,
      );

      cleanup();

      expect(document.documentElement.hasAttribute("data-app-title-band")).toBe(
        false,
      );
    },
  );

  describe("the task surface frame (no tray wrapper)", () => {
    it.each([TOP, LEFT_NONE, RIGHT_BAND])(
      "sits directly under <main>, with no wrapper around it, for $placement",
      (chrome) => {
        renderFrame(chrome);

        const frame = surfaceFrame();
        const main = screen.getByRole("main");
        // One-sheet design: the frame is `<main>`'s own child that holds the
        // surface, not a second box a tray wraps it in.
        expect(frame.parentElement).toBe(main);
        expect(frame.classList.contains("md:task-surface-frame")).toBe(true);
      },
    );

    it.each([TOP, LEFT_NONE, RIGHT_BAND])(
      "stamps data-tab-edge with the strip's own edge for $placement",
      (chrome) => {
        renderFrame(chrome);

        expect(surfaceFrame().dataset.tabEdge).toBe(chrome.placement);
      },
    );

    it("renders exactly one top join bridge for the top placement", () => {
      renderFrame(TOP);

      expect(
        document.querySelectorAll('[data-sheet-join-bridge="top"]'),
      ).toHaveLength(1);
    });

    it("activates the top bridge for a published join and clears it when the join is withdrawn", () => {
      renderFrameWith(TOP, <TogglePublisher id="a" pane="canvas" />);
      const bridge = document.querySelector('[data-sheet-join-bridge="top"]');

      expect(bridge?.hasAttribute("data-join-active")).toBe(true);
      expect(bridge?.getAttribute("data-join-pane")).toBe("canvas");

      fireEvent.click(screen.getByTestId("join-toggle-a"));

      expect(bridge?.hasAttribute("data-join-active")).toBe(false);
      expect(bridge?.hasAttribute("data-join-pane")).toBe(false);
    });

    // The scope's ordering contract for overlapping eligible publishers: the
    // bridge shows the most recently published one, and withdrawing any
    // publisher - in either order - leaves it on the latest one still up.
    it.each([
      {
        order: "the newer withdrawn first",
        steps: [
          { click: "join-toggle-b", pane: "panel" },
          { click: "join-toggle-a", pane: null },
        ],
      },
      {
        order: "the older withdrawn first",
        steps: [
          { click: "join-toggle-a", pane: "canvas" },
          { click: "join-toggle-b", pane: null },
        ],
      },
    ])(
      "keeps the bridge on the remaining publisher with $order",
      ({ steps }) => {
        renderFrameWith(
          TOP,
          <>
            <TogglePublisher id="a" pane="panel" />
            <TogglePublisher id="b" pane="canvas" />
          </>,
        );
        const bridge = document.querySelector('[data-sheet-join-bridge="top"]');
        expect(bridge?.getAttribute("data-join-pane")).toBe("canvas");

        for (const step of steps) {
          fireEvent.click(screen.getByTestId(step.click));
          expect(bridge?.getAttribute("data-join-pane")).toBe(step.pane);
          expect(bridge?.hasAttribute("data-join-active")).toBe(
            step.pane !== null,
          );
        }
      },
    );

    it("leaves the top bridge inactive while nothing publishes a join", () => {
      renderFrame(TOP);

      expect(
        document
          .querySelector('[data-sheet-join-bridge="top"]')
          ?.hasAttribute("data-join-active"),
      ).toBe(false);
    });

    it.each([LEFT_NONE, RIGHT_BAND])(
      "renders no join bridge from the frame itself for a side placement ($placement)",
      (chrome) => {
        renderFrame(chrome);

        expect(
          document.querySelectorAll("[data-sheet-join-bridge]"),
        ).toHaveLength(0);
      },
    );
  });
});
