/**
 * Harness logos as 12x12 pixel-art sprites, for the nameplate on an agent's
 * desk.
 *
 * THE APP'S OWN ICONS, NOT A SECOND SET. The office draws the same brand marks
 * every picker and chat row draws (`PROVIDER_ICON_CONFIG`), so a harness cannot
 * end up with two different faces in one product. They arrive as React SVG
 * components, and a canvas cannot draw a React component - so each one is
 * rendered once, serialized, and rasterized into a tiny offscreen canvas with
 * smoothing off, which is what makes a vector mark land as pixel art.
 *
 * RASTERIZING IS ASYNCHRONOUS and the frame loop is not. `officeHarnessLogo`
 * therefore never blocks: it returns `null` until a logo is ready and starts
 * the work on the first miss. A frame that finds `null` draws nothing and the
 * next one picks the logo up - which is why nothing here needs to tell the
 * renderer that anything changed.
 *
 * WHERE THERE IS NO CANVAS AND NO IMAGE DECODER (jsdom), every path here is a
 * silent no-op. That is not defensive: the office's own suite runs there, and a
 * missing logo is exactly what an unfinished decode looks like anyway.
 */
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { GuiHarnessId } from "@traycer/protocol/persistence/epic/schemas";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { HARNESS_ACCENT } from "@/lib/comm-graph/office/office-appearance";
import {
  OFFICE_LOGO_SIZE,
  type OfficeTheme,
} from "@/lib/comm-graph/office/office-types";

/**
 * A logo's slot in the cache. `null` means "asked for, still rasterizing or
 * permanently unavailable" - both are drawn the same way (not at all), so they
 * do not need telling apart, and keeping the key present is what stops a
 * failed build from being retried on every frame.
 */
type LogoSlot = HTMLCanvasElement | null;

const logoCache = new Map<string, LogoSlot>();

function cacheKey(harnessId: GuiHarnessId, theme: OfficeTheme): string {
  return `${harnessId}:${theme}`;
}

/**
 * A 2d context, or `null` where the platform has no canvas. jsdom throws
 * "Not implemented" rather than returning null, so this is the one boundary
 * where catching is the cleanest capability probe.
 */
function offscreenContext(
  canvas: HTMLCanvasElement,
): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext("2d");
  } catch {
    return null;
  }
}

/**
 * The harness icon's SVG markup, recolored to the harness accent and sized to
 * the sprite box.
 *
 * Rendered through a REAL React root into a detached element rather than
 * through a server renderer: the icons are ordinary components, and pulling a
 * server-rendering entry point into the browser bundle to stringify twenty
 * small SVGs is a dependency this earns nothing by having.
 */
function renderLogoMarkup(harnessId: GuiHarnessId): string | null {
  if (typeof document === "undefined") return null;
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    // Synchronous on purpose: the markup has to exist by the next statement,
    // and this root is detached, so nothing user-visible is being flushed.
    flushSync(() => {
      root.render(createElement(HarnessIcon, { harnessId }));
    });
    const svg = host.querySelector("svg");
    if (svg === null) return null;
    svg.setAttribute("width", String(OFFICE_LOGO_SIZE));
    svg.setAttribute("height", String(OFFICE_LOGO_SIZE));
    // The icons paint with `currentColor`, which resolves against a cascade a
    // detached node does not have. Naming the accent explicitly is what makes
    // the mark visible once it is a standalone document.
    svg.setAttribute("color", HARNESS_ACCENT[harnessId]);
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    return svg.outerHTML;
  } finally {
    root.unmount();
  }
}

function rasterizeLogo(harnessId: GuiHarnessId, theme: OfficeTheme): void {
  const key = cacheKey(harnessId, theme);
  const markup = renderLogoMarkup(harnessId);
  if (markup === null) return;
  if (
    typeof Image !== "function" ||
    typeof URL.createObjectURL !== "function"
  ) {
    return;
  }
  const url = URL.createObjectURL(
    new Blob([markup], { type: "image/svg+xml" }),
  );
  const image = new Image();
  image.onload = () => {
    URL.revokeObjectURL(url);
    const canvas = document.createElement("canvas");
    canvas.width = OFFICE_LOGO_SIZE;
    canvas.height = OFFICE_LOGO_SIZE;
    const ctx = offscreenContext(canvas);
    if (ctx === null) return;
    // Smoothing off on the way IN, so the mark is quantized to the sprite grid
    // once here rather than resampled on every frame it is drawn.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, 0, 0, OFFICE_LOGO_SIZE, OFFICE_LOGO_SIZE);
    logoCache.set(key, canvas);
  };
  image.onerror = () => {
    URL.revokeObjectURL(url);
  };
  image.src = url;
}

/**
 * The rasterized logo for a harness, or `null` while it is not ready. Starts
 * the work on the first miss and never blocks the caller.
 */
export function officeHarnessLogo(
  harnessId: GuiHarnessId,
  theme: OfficeTheme,
): HTMLCanvasElement | null {
  const key = cacheKey(harnessId, theme);
  if (logoCache.has(key)) return logoCache.get(key) ?? null;
  // Claim the slot BEFORE the async work, so a floor with ten agents on one
  // harness starts one rasterization rather than ten.
  logoCache.set(key, null);
  rasterizeLogo(harnessId, theme);
  return null;
}

export function clearOfficeLogoCache(): void {
  logoCache.clear();
}
