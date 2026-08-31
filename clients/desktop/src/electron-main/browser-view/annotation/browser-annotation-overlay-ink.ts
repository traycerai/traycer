/**
 * Freehand ink for the isolated-world overlay: perfect-freehand path building
 * plus the in-progress draft stroke. Coordinates are page-space; the caller
 * supplies the page → viewport conversion.
 */
import { getStroke } from "perfect-freehand";
import {
  ANNOTATION_STROKE_HALO_SIZE_PX,
  ANNOTATION_STROKE_SIZE_PX,
  svgPathFromPolygon,
} from "./browser-annotation-overlay-logic";

export interface StrokePoint {
  readonly x: number;
  readonly y: number;
}

const STROKE_OPTIONS = {
  size: ANNOTATION_STROKE_SIZE_PX,
  thinning: 0.55,
  smoothing: 0.5,
  streamline: 0.45,
  simulatePressure: true,
};

const HALO_OPTIONS = {
  size: ANNOTATION_STROKE_HALO_SIZE_PX,
  thinning: 0.35,
  smoothing: 0.5,
  streamline: 0.45,
  simulatePressure: true,
};

function strokePathD(points: readonly StrokePoint[], size: number): string {
  const input = points.map((point) => [point.x, point.y] as [number, number]);
  const outline = getStroke(
    input,
    size === ANNOTATION_STROKE_HALO_SIZE_PX ? HALO_OPTIONS : STROKE_OPTIONS,
  );
  return svgPathFromPolygon(outline);
}

export function makeInkPath(D: Document, className: string): SVGPathElement {
  const path = D.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("class", className);
  path.setAttribute("fill-rule", "nonzero");
  return path;
}

export function paintStrokePaths(
  points: readonly StrokePoint[],
  haloLight: SVGPathElement,
  haloDark: SVGPathElement,
  ink: SVGPathElement,
): void {
  haloLight.setAttribute(
    "d",
    strokePathD(points, ANNOTATION_STROKE_HALO_SIZE_PX),
  );
  haloDark.setAttribute(
    "d",
    strokePathD(points, ANNOTATION_STROKE_HALO_SIZE_PX),
  );
  ink.setAttribute("d", strokePathD(points, ANNOTATION_STROKE_SIZE_PX));
}

export interface DraftStroke {
  readonly isDrawing: () => boolean;
  readonly begin: (point: StrokePoint) => void;
  readonly extend: (point: StrokePoint) => void;
  /** Repaints the in-progress stroke (e.g. after a scroll). */
  readonly repaint: () => void;
  readonly clear: () => void;
  /** Returns the collected points and clears the draft. */
  readonly finish: () => StrokePoint[];
}

export function createDraftStroke(input: {
  readonly document: Document;
  readonly svg: SVGSVGElement;
  readonly toViewport: (points: readonly StrokePoint[]) => StrokePoint[];
}): DraftStroke {
  const D = input.document;
  const svg = input.svg;
  let drawing = false;
  let points: StrokePoint[] = [];
  let halo: SVGPathElement | null = null;
  let haloDark: SVGPathElement | null = null;
  let ink: SVGPathElement | null = null;

  function paint(): void {
    if (halo === null || haloDark === null || ink === null) return;
    paintStrokePaths(input.toViewport(points), halo, haloDark, ink);
  }

  function clear(): void {
    drawing = false;
    points = [];
    halo?.remove();
    haloDark?.remove();
    ink?.remove();
    halo = null;
    haloDark = null;
    ink = null;
  }

  return {
    isDrawing: () => drawing,
    begin: (point) => {
      drawing = true;
      points = [point];
      haloDark = makeInkPath(D, "halo-dark");
      halo = makeInkPath(D, "halo-light");
      ink = makeInkPath(D, "pen");
      svg.appendChild(haloDark);
      svg.appendChild(halo);
      svg.appendChild(ink);
      paint();
    },
    extend: (point) => {
      points.push(point);
      paint();
    },
    repaint: () => {
      if (!drawing) return;
      paint();
    },
    clear,
    finish: () => {
      const collected = points.slice();
      clear();
      return collected;
    },
  };
}
