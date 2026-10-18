import { act } from "@testing-library/react";
import { vi } from "vitest";
import type { HtmlElement } from "@traycer/html-source";
import type { SandboxBridgeHost } from "@/lib/sandbox/bridge-host";
import type { CanvasElement } from "@/lib/sandbox/canvas-bridge";
import type {
  CanvasLayoutNode,
  CanvasSiblingLayout,
} from "@/lib/sandbox/canvas-layout-bridge";
import type { CanvasBoardDocument } from "../canvas-board-document";
import type { CanvasFrameRegistry } from "../canvas-frame-registry";
import {
  useCanvasSelectionStore,
  type CanvasSelection,
} from "../canvas-selection-store";
import {
  ARTIFACT_ID,
  BOARD_PATH,
  boardDocument,
  canvasElement,
  realBridge,
  registryServing,
} from "./canvas-edit-test-support";

/** The revision every fixture is served at; `boardDocument` uses the same. */
export const SERVED_SHA = "sha-served";

export function structureDocument(html: string): CanvasBoardDocument {
  return boardDocument(html);
}

function sourceOf(document: CanvasBoardDocument, tid: string): HtmlElement {
  const found = document.parsed.elements.find(
    (element) => element.effectiveTid === tid && element.startTag !== null,
  );
  if (found === undefined) throw new Error(`the fixture has no ${tid}`);
  return found;
}

/** What the page reports for the element the fixture marks with `tid`. */
export function elementFor(
  document: CanvasBoardDocument,
  tid: string,
): CanvasElement {
  const source = sourceOf(document, tid);
  return canvasElement({
    marker: source.startTag?.start ?? null,
    tid,
    tagName: source.tagName,
    selector: `[data-tid=${tid}]`,
  });
}

export function selectionFor(element: CanvasElement): CanvasSelection {
  return {
    artifactId: ARTIFACT_ID,
    boardPath: BOARD_PATH,
    page: null,
    servedSha256: SERVED_SHA,
    element,
    textRange: null,
  };
}

export interface NodeFacts {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly position: string;
  readonly transformed: boolean;
  /** `false` for an element whose CSS size is not a plain length. */
  readonly sized: boolean;
}

/** An absolutely positioned child at its own `left` / `top`. */
export function placedAt(
  x: number,
  y: number,
  width: number,
  height: number,
): NodeFacts {
  return {
    x,
    y,
    width,
    height,
    position: "absolute",
    transformed: false,
    sized: true,
  };
}

/** A static child of a row, the kind of box a reorder can address. */
export function flowAt(
  x: number,
  y: number,
  width: number,
  height: number,
): NodeFacts {
  return {
    x,
    y,
    width,
    height,
    position: "static",
    transformed: false,
    sized: true,
  };
}

function layoutNodeFor(
  document: CanvasBoardDocument,
  tid: string,
  facts: NodeFacts,
): CanvasLayoutNode {
  const source = sourceOf(document, tid);
  return {
    marker: source.startTag?.start ?? null,
    tid,
    tagName: source.tagName,
    box: { x: facts.x, y: facts.y, width: facts.width, height: facts.height },
    position: facts.position,
    left: facts.x,
    top: facts.y,
    cssWidth: facts.sized ? facts.width : null,
    cssHeight: facts.sized ? facts.height : null,
    transformed: facts.transformed,
  };
}

/** The live layout of `parentTid`'s children, in the order given. */
export function layoutOf(
  document: CanvasBoardDocument,
  parentTid: string,
  children: Readonly<Record<string, NodeFacts>>,
): CanvasSiblingLayout {
  return {
    parent: layoutNodeFor(document, parentTid, {
      x: 0,
      y: 0,
      width: 400,
      height: 100,
      position: "relative",
      transformed: false,
      sized: true,
    }),
    siblings: Object.entries(children).map(([tid, facts]) =>
      layoutNodeFor(document, tid, facts),
    ),
    axis: "x",
    reverse: false,
    truncated: false,
  };
}

export interface FrameGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
}

/** The board's frame drawn at actual size, at the page origin. */
export const FRAME_ACTUAL: FrameGeometry = {
  x: 0,
  y: 0,
  width: 800,
  height: 400,
  clientWidth: 800,
  clientHeight: 400,
};

/**
 * An iframe element jsdom cannot lay out, given the box it would have on the
 * canvas. `width` over `clientWidth` is the canvas zoom.
 */
export function frameWith(geometry: FrameGeometry): HTMLIFrameElement {
  const frame = window.document.createElement("iframe");
  frame.getBoundingClientRect = () =>
    new DOMRect(geometry.x, geometry.y, geometry.width, geometry.height);
  Object.defineProperty(frame, "clientWidth", { value: geometry.clientWidth });
  Object.defineProperty(frame, "clientHeight", {
    value: geometry.clientHeight,
  });
  return frame;
}

/** jsdom has no pointer capture; a gesture only needs the calls to succeed. */
export function installPointerCapture(): void {
  for (const name of ["setPointerCapture", "releasePointerCapture"]) {
    Object.defineProperty(HTMLElement.prototype, name, {
      value: () => undefined,
      configurable: true,
      writable: true,
    });
  }
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
    value: () => true,
    configurable: true,
    writable: true,
  });
}

export interface StructureHarness {
  readonly bridge: SandboxBridgeHost;
  readonly registry: CanvasFrameRegistry;
  readonly frame: HTMLIFrameElement;
  /** Every locator the page was asked about, in order. */
  readonly asked: () => readonly unknown[];
  /** The layout the page currently reports; replace it to play a page change. */
  readonly report: (layout: CanvasSiblingLayout | null) => void;
  /** Holds every answer until `release` runs, to observe the wait. */
  readonly hold: () => () => void;
}

/** A mounted board whose page answers `siblingLayout` with what `report` set. */
export function structureHarness(
  layout: CanvasSiblingLayout,
  geometry: FrameGeometry,
): StructureHarness {
  const bridge = realBridge();
  let current: CanvasSiblingLayout | null = layout;
  let gate: Promise<void> | null = null;
  const asked: unknown[] = [];
  vi.spyOn(bridge, "siblingLayout").mockImplementation(async (locator) => {
    asked.push(locator);
    if (gate !== null) await gate;
    return current;
  });
  const registry = registryServing(bridge, SERVED_SHA);
  const frame = frameWith(geometry);
  registry.update(BOARD_PATH, { frame });
  return {
    bridge,
    registry,
    frame,
    asked: () => asked,
    report: (next) => {
      current = next;
    },
    hold: () => {
      let release: () => void = () => undefined;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        gate = null;
        release();
      };
    },
  };
}

/** Selection changes outside React's own events need `act`. */
export function selectOnly(selection: CanvasSelection): void {
  act(() => {
    useCanvasSelectionStore.getState().select(selection);
  });
}

/**
 * Makes `primary` the selection and adds `others` to it, as shift-clicks would,
 * each one checked against `layout`, the live container the page reports.
 */
export function selectSet(
  primary: CanvasSelection,
  others: readonly CanvasSelection[],
  layout: CanvasSiblingLayout | null,
): void {
  const owner = Symbol("structure test");
  act(() => {
    const store = useCanvasSelectionStore.getState();
    store.completePick(
      owner,
      store.beginPick(owner, primary.artifactId, primary.boardPath),
      primary,
    );
    for (const other of others) {
      const generation = useCanvasSelectionStore
        .getState()
        .beginPick(owner, other.artifactId, other.boardPath);
      useCanvasSelectionStore
        .getState()
        .completeAdditivePick(owner, generation, other, layout);
    }
  });
}

/** Lets the sibling-layout reader and any pending save requests run. */
export async function settleLayout(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  });
}
