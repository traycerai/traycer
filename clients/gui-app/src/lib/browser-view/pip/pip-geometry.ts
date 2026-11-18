import type { EpicPipGeometry } from "@/stores/epics/canvas/types";

export const PIP_MIN_WIDTH = 240;
export const PIP_MIN_HEIGHT = 148;
export const PIP_MAX_WIDTH = 480;
export const PIP_MAX_HEIGHT = 360;
export const PIP_DEFAULT_WIDTH = 320;
export const PIP_DEFAULT_HEIGHT = 200;
export const PIP_VIEWPORT_MARGIN = 16;
export const PIP_DEFAULT_BOTTOM_INSET = 56;
export const PIP_NUDGE_PX = 8;
export const PIP_RESIZE_STEP_PX = 16;

type PipCorner = "bottom-right" | "bottom-left" | "top-left" | "top-right";

export const PIP_CORNER_CYCLE: readonly PipCorner[] = [
  "bottom-right",
  "bottom-left",
  "top-left",
  "top-right",
];

export function defaultPipGeometry(viewport: ViewportSize): EpicPipGeometry {
  const previewWidth = Math.min(
    PIP_DEFAULT_WIDTH,
    maxWidthForViewport(viewport),
  );
  const previewHeight = Math.min(
    PIP_DEFAULT_HEIGHT,
    maxHeightForViewport(viewport),
  );
  return clampPipGeometry(
    {
      anchorX: viewport.width - PIP_VIEWPORT_MARGIN,
      anchorY: viewport.height - PIP_DEFAULT_BOTTOM_INSET,
      previewWidth,
      previewHeight,
    },
    viewport,
    previewHeight,
  );
}

export function clampPipGeometry(
  geometry: EpicPipGeometry,
  viewport: ViewportSize,
  outerHeight: number,
): EpicPipGeometry {
  const maxWidth = maxWidthForViewport(viewport);
  const maxHeight = maxHeightForViewport(viewport);
  const previewWidth = clampNumber(
    geometry.previewWidth,
    PIP_MIN_WIDTH,
    maxWidth,
  );
  const previewHeight = clampNumber(
    geometry.previewHeight,
    PIP_MIN_HEIGHT,
    maxHeight,
  );
  const clampedOuterHeight = Math.min(
    Math.max(previewHeight, outerHeight),
    viewport.height - PIP_VIEWPORT_MARGIN * 2,
  );
  return {
    anchorX: clampNumber(
      geometry.anchorX,
      PIP_VIEWPORT_MARGIN + previewWidth,
      viewport.width - PIP_VIEWPORT_MARGIN,
    ),
    anchorY: clampNumber(
      geometry.anchorY,
      PIP_VIEWPORT_MARGIN + clampedOuterHeight,
      viewport.height - PIP_VIEWPORT_MARGIN,
    ),
    previewWidth,
    previewHeight,
  };
}

export function geometryForCorner(
  corner: PipCorner,
  size: {
    readonly previewWidth: number;
    readonly previewHeight: number;
  },
  viewport: ViewportSize,
  outerHeight: number,
): EpicPipGeometry {
  const previewWidth = clampNumber(
    size.previewWidth,
    PIP_MIN_WIDTH,
    maxWidthForViewport(viewport),
  );
  const previewHeight = clampNumber(
    size.previewHeight,
    PIP_MIN_HEIGHT,
    maxHeightForViewport(viewport),
  );
  const right = viewport.width - PIP_VIEWPORT_MARGIN;
  const bottom = viewport.height - PIP_DEFAULT_BOTTOM_INSET;
  const left = PIP_VIEWPORT_MARGIN + previewWidth;
  const top = PIP_VIEWPORT_MARGIN + outerHeight;
  switch (corner) {
    case "bottom-right":
      return clampPipGeometry(
        { anchorX: right, anchorY: bottom, previewWidth, previewHeight },
        viewport,
        outerHeight,
      );
    case "bottom-left":
      return clampPipGeometry(
        { anchorX: left, anchorY: bottom, previewWidth, previewHeight },
        viewport,
        outerHeight,
      );
    case "top-left":
      return clampPipGeometry(
        { anchorX: left, anchorY: top, previewWidth, previewHeight },
        viewport,
        outerHeight,
      );
    case "top-right":
      return clampPipGeometry(
        { anchorX: right, anchorY: top, previewWidth, previewHeight },
        viewport,
        outerHeight,
      );
  }
}

export function nextPipCorner(
  current: EpicPipGeometry,
  viewport: ViewportSize,
  outerHeight: number,
): PipCorner {
  const midX = current.anchorX - current.previewWidth / 2;
  const midY = current.anchorY - outerHeight / 2;
  const right = midX >= viewport.width / 2;
  const bottom = midY >= viewport.height / 2;
  const currentCorner = cornerFromQuadrant(right, bottom);
  const index = PIP_CORNER_CYCLE.indexOf(currentCorner);
  return PIP_CORNER_CYCLE[(index + 1) % PIP_CORNER_CYCLE.length];
}

export function readViewportSize(): ViewportSize {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

function maxWidthForViewport(viewport: ViewportSize): number {
  return Math.max(
    PIP_MIN_WIDTH,
    Math.min(PIP_MAX_WIDTH, viewport.width - PIP_VIEWPORT_MARGIN * 2),
  );
}

function maxHeightForViewport(viewport: ViewportSize): number {
  return Math.max(
    PIP_MIN_HEIGHT,
    Math.min(PIP_MAX_HEIGHT, viewport.height - PIP_VIEWPORT_MARGIN * 2),
  );
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function cornerFromQuadrant(right: boolean, bottom: boolean): PipCorner {
  if (bottom && right) return "bottom-right";
  if (bottom) return "bottom-left";
  if (right) return "top-right";
  return "top-left";
}
