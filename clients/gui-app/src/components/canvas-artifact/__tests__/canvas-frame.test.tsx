import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SandboxFrameProps,
  SandboxSource,
} from "@/components/sandbox/sandbox-frame";
import type { SandboxSize } from "@/lib/sandbox/bridge-host";
import { CanvasBoardFrame, type CanvasFrameEvents } from "../canvas-frame";
import {
  CanvasNodeContext,
  type CanvasNodeActions,
} from "../canvas-node-context";

const BOARD = "boards/a.html";
const TITLE = "Board A";
const SOURCE: SandboxSource = { kind: "html", html: "<p>board</p>" };

// The real frame boots a sandboxed iframe; the board only needs its size
// callback and the iframe element it hands back through `ref`.
const frameProps = vi.hoisted(() => ({
  current: null as SandboxFrameProps | null,
}));

vi.mock("@/components/sandbox/sandbox-frame", () => ({
  SandboxFrame: (props: SandboxFrameProps) => {
    frameProps.current = props;
    return <iframe title={props.title} ref={props.ref} />;
  },
}));

const fitBoardHeight = vi.fn<(path: string, height: number) => void>();
const onSize = vi.fn<(path: string, size: SandboxSize) => void>();

function actionsFor(viewOnly: boolean): CanvasNodeActions {
  return {
    viewOnly,
    selectionEnabled: true,
    panMode: false,
    onAddError: () => undefined,
    sourceForBoard: () => null,
    frameEvents: null,
    renameBoard: () => undefined,
    toggleInteractive: () => undefined,
    resize: () => undefined,
    setNoteText: () => undefined,
    updateNote: () => undefined,
    editingNote: null,
    setEditingNote: () => undefined,
    fitBoardHeight,
    fullscreen: () => undefined,
  };
}

const EVENTS: CanvasFrameEvents = {
  onBridge: () => undefined,
  onStatus: () => undefined,
  onEditPointer: () => undefined,
  onSize,
};

function mountBoard(options: {
  readonly actions: CanvasNodeActions | null;
  readonly fullscreen?: boolean;
  readonly viewportHeight: number;
}): HTMLIFrameElement {
  render(
    <CanvasNodeContext.Provider value={options.actions}>
      <CanvasBoardFrame
        path={BOARD}
        title={TITLE}
        source={SOURCE}
        events={EVENTS}
        fullscreen={options.fullscreen ?? false}
        mode="edit"
      />
    </CanvasNodeContext.Provider>,
  );
  const iframe = screen.getByTitle(TITLE);
  if (!(iframe instanceof HTMLIFrameElement))
    throw new Error("the board did not render an iframe");
  // jsdom has no layout, so the viewport the board is measured against is injected.
  Object.defineProperty(iframe, "clientHeight", {
    configurable: true,
    value: options.viewportHeight,
  });
  return iframe;
}

function reportSize(height: number | null): void {
  const props = frameProps.current;
  if (props === null) throw new Error("the board never rendered a frame");
  props.onSize({ width: 1280, height });
}

beforeEach(() => {
  frameProps.current = null;
  fitBoardHeight.mockReset();
  onSize.mockReset();
});

afterEach(cleanup);

describe("CanvasBoardFrame height fit", () => {
  it("writes the page's own height when it is shorter than the board", () => {
    mountBoard({ actions: actionsFor(false), viewportHeight: 800 });

    reportSize(420);

    expect(fitBoardHeight).toHaveBeenCalledExactlyOnceWith(BOARD, 420);
  });

  it("keeps the nominal height for a page that fills the viewport, within one pixel", () => {
    mountBoard({ actions: actionsFor(false), viewportHeight: 500 });

    reportSize(499);

    expect(fitBoardHeight).toHaveBeenCalledExactlyOnceWith(BOARD, 800);
  });

  it("keeps the real height of content that overflows the viewport", () => {
    mountBoard({ actions: actionsFor(false), viewportHeight: 500 });

    reportSize(2400);

    expect(fitBoardHeight).toHaveBeenCalledExactlyOnceWith(BOARD, 2400);
  });

  it("fits a page just under the one pixel tolerance", () => {
    mountBoard({ actions: actionsFor(false), viewportHeight: 500 });

    reportSize(498);

    expect(fitBoardHeight).toHaveBeenCalledExactlyOnceWith(BOARD, 498);
  });

  it("never writes a height under the 60 pixel board minimum", () => {
    mountBoard({ actions: actionsFor(false), viewportHeight: 800 });

    reportSize(12);

    expect(fitBoardHeight).toHaveBeenCalledExactlyOnceWith(BOARD, 60);
  });

  it("fits once, so the size feedback of the fitted board cannot resize it again", () => {
    mountBoard({ actions: actionsFor(false), viewportHeight: 800 });

    reportSize(420);
    reportSize(300);
    reportSize(700);

    expect(fitBoardHeight).toHaveBeenCalledTimes(1);
  });

  it("does not use up the one fit on a size it could not measure against", () => {
    const iframe = mountBoard({
      actions: actionsFor(false),
      viewportHeight: 0,
    });

    reportSize(420);
    expect(fitBoardHeight).not.toHaveBeenCalled();

    Object.defineProperty(iframe, "clientHeight", {
      configurable: true,
      value: 800,
    });
    reportSize(420);
    expect(fitBoardHeight).toHaveBeenCalledExactlyOnceWith(BOARD, 420);
  });

  it.each([
    ["a null height", null],
    ["a non-finite height", Number.NaN],
    ["an infinite height", Number.POSITIVE_INFINITY],
  ])("ignores %s", (_name, height) => {
    mountBoard({ actions: actionsFor(false), viewportHeight: 800 });

    reportSize(height);

    expect(fitBoardHeight).not.toHaveBeenCalled();
  });

  it("leaves a view-only canvas alone", () => {
    mountBoard({ actions: actionsFor(true), viewportHeight: 800 });

    reportSize(420);

    expect(fitBoardHeight).not.toHaveBeenCalled();
  });

  it("leaves a fullscreen board alone, since its frame is the window", () => {
    mountBoard({
      actions: actionsFor(false),
      fullscreen: true,
      viewportHeight: 800,
    });

    reportSize(420);

    expect(fitBoardHeight).not.toHaveBeenCalled();
  });

  it("renders and reports sizes outside a canvas surface", () => {
    mountBoard({ actions: null, viewportHeight: 800 });

    reportSize(420);

    expect(fitBoardHeight).not.toHaveBeenCalled();
    expect(onSize).toHaveBeenCalledWith(BOARD, { width: 1280, height: 420 });
  });

  it.each([
    ["view-only", actionsFor(true), false],
    ["fullscreen", actionsFor(false), true],
    ["detached", null, false],
  ])(
    "still forwards every size to the registry when %s",
    (_name, actions, fullscreen) => {
      mountBoard({ actions, fullscreen, viewportHeight: 800 });

      reportSize(420);
      reportSize(null);

      expect(onSize.mock.calls).toEqual([
        [BOARD, { width: 1280, height: 420 }],
        [BOARD, { width: 1280, height: null }],
      ]);
    },
  );
});
