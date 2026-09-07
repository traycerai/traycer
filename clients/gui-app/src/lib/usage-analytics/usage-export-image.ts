import { toBlob } from "html-to-image";
import {
  TRAYCER_MARK_PATH_D,
  TRAYCER_MARK_VIEWBOX,
} from "@/lib/brand/traycer-mark";

/**
 * Marks the shareable region of a usage surface.
 * Each surface puts the bare attribute (`data-usage-export-region=""`) on its summary wrapper and resolves it at click time, scoped under its own root node so two mounted usage surfaces can never capture each other's region.
 */
export const USAGE_EXPORT_REGION_SELECTOR = "[data-usage-export-region]";

/**
 * Marks a node INSIDE the export region that must not appear in the shared image (workspace-internal detail like the by-host split).
 * The live surface keeps rendering it; only the capture clone drops it.
 */
const USAGE_EXPORT_EXCLUDE_SELECTOR = "[data-usage-export-exclude]";

/**
 * Marks a horizontal scroller INSIDE the export region whose full content must appear in the shared image, scaled down to fit (the year-wide activity heatmap).
 * A shared image has no scrollbar, so capturing the scroller as-is would silently crop the year to whatever slice the live surface happened to be scrolled to.
 */
export const USAGE_EXPORT_FIT_SELECTOR = "[data-usage-export-fit]";

/**
 * Marks a node whose TEXT must be replaced in the shared image with the attribute's value - for copy that is right on the live page but leaks workspace-internal detail in a screenshot (a host's display name in the cost figure's scope note).
 */
export const USAGE_EXPORT_REDACT_ATTRIBUTE = "data-usage-export-redact";

const SVG_NS = "http://www.w3.org/2000/svg";
const EXPORT_PADDING_PX = 32;

export interface UsageExportImageParams {
  /** The live summary region to rasterise. */
  readonly region: HTMLElement;
  /** Heading drawn above the region ("Usage"). */
  readonly heading: string;
  /** Muted line beside the heading (scope or date range) - `null` for none. */
  readonly subheading: string | null;
}

/**
 * Rasterise a usage summary region into a shareable PNG: padding around the content, a heading row above it, and a Traycer branding footer below, composed in an offscreen wrapper rather than drawn onto a canvas so the frame uses the app's real fonts, theme.
 */
export async function captureUsageExportImageBlob(
  params: UsageExportImageParams,
): Promise<Blob> {
  const { region, heading, subheading } = params;
  const background = resolveOpaqueBackgroundColor(region);
  const wrapper = document.createElement("div");
  wrapper.className = "usage-chart-root @container flex flex-col gap-5";
  wrapper.style.position = "fixed";
  wrapper.style.left = "-100000px";
  wrapper.style.top = "0";
  wrapper.style.boxSizing = "content-box";
  wrapper.style.width = `${String(region.getBoundingClientRect().width)}px`;
  wrapper.style.padding = `${String(EXPORT_PADDING_PX)}px`;
  wrapper.style.backgroundColor = background;

  wrapper.appendChild(buildHeader(heading, subheading));
  wrapper.appendChild(cloneRegionWithResolvedPalette(region));
  wrapper.appendChild(buildBrandingFooter());

  // Parked offscreen but still in the document: without these, keyboard and assistive tech can reach the clone's dead buttons while a slow rasterisation is in flight.
  wrapper.setAttribute("inert", "");
  wrapper.setAttribute("aria-hidden", "true");
  wrapper.style.pointerEvents = "none";
  document.body.appendChild(wrapper);
  try {
    const blob = await toBlob(wrapper, {
      pixelRatio: 2,
      backgroundColor: background,
      // The wrapper parks offscreen (`fixed; left: -100000px`) while it lays out, and html-to-image inlines COMPUTED styles - without this reset the clone keeps that offset, the canvas paints at (0,0), and the export is a solid background with every pixel of.
      style: { position: "static", left: "0", top: "0" },
    });
    if (blob === null) {
      throw new Error("usage image capture produced no image");
    }
    return blob;
  } finally {
    wrapper.remove();
  }
}

function buildHeader(heading: string, subheading: string | null): HTMLElement {
  const header = document.createElement("div");
  header.className =
    "flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1";
  const title = document.createElement("span");
  title.className = "text-lg font-semibold text-foreground";
  title.textContent = heading;
  header.appendChild(title);
  if (subheading !== null) {
    const sub = document.createElement("span");
    sub.className = "text-ui-sm text-muted-foreground";
    sub.textContent = subheading;
    header.appendChild(sub);
  }
  return header;
}

/**
 * The same lockup the onboarding wordmark renders - mark + lowercase "traycer" in the heading face - with the site opposite it.
 */
function buildBrandingFooter(): HTMLElement {
  const footer = document.createElement("div");
  footer.className =
    "flex items-center justify-between gap-3 border-t border-border/60 pt-4";
  const lockup = document.createElement("div");
  lockup.className = "flex items-center gap-2 text-foreground";
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", TRAYCER_MARK_VIEWBOX);
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("fill-rule", "evenodd");
  path.setAttribute("clip-rule", "evenodd");
  path.setAttribute("d", TRAYCER_MARK_PATH_D);
  svg.appendChild(path);
  const word = document.createElement("span");
  word.className = "font-heading text-ui-sm font-medium";
  word.textContent = "traycer";
  lockup.appendChild(svg);
  lockup.appendChild(word);
  const site = document.createElement("span");
  site.className = "text-ui-xs text-muted-foreground";
  site.textContent = "traycer.ai";
  footer.appendChild(lockup);
  footer.appendChild(site);
  return footer;
}

/** Deep-clone the region and fix up everything a bare `cloneNode` loses: */
function cloneRegionWithResolvedPalette(region: HTMLElement): HTMLElement {
  const clone = region.cloneNode(true);
  if (!(clone instanceof HTMLElement)) {
    throw new Error("region clone is not an element");
  }
  const sources = region.querySelectorAll("*");
  const targets = clone.querySelectorAll("*");
  const attributes = ["fill", "stroke", "stop-color"];
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const target = targets[i];
    if (source instanceof SVGElement && target instanceof SVGElement) {
      for (const name of attributes) {
        const value = source.getAttribute(name);
        if (value === null || !value.includes("var(")) continue;
        const computed = getComputedStyle(source).getPropertyValue(name);
        if (computed !== "") {
          target.setAttribute(name, computed);
        }
      }
    }
    if (
      source instanceof HTMLElement &&
      target instanceof HTMLElement &&
      source.matches(USAGE_EXPORT_FIT_SELECTOR)
    ) {
      fitScrollerToWidth(source, target);
    }
  }
  for (const excluded of clone.querySelectorAll(
    USAGE_EXPORT_EXCLUDE_SELECTOR,
  )) {
    excluded.remove();
  }
  for (const redacted of clone.querySelectorAll(
    `[${USAGE_EXPORT_REDACT_ATTRIBUTE}]`,
  )) {
    redacted.textContent =
      redacted.getAttribute(USAGE_EXPORT_REDACT_ATTRIBUTE) ?? "";
  }
  return clone;
}

/**
 * Shrink a marked scroller's clone until its whole scrollable content fits the width it has on screen - the heatmap's full year rather than the ~3 visible months.
 */
function fitScrollerToWidth(source: HTMLElement, target: HTMLElement): void {
  const { clientWidth, scrollWidth, scrollHeight } = source;
  if (scrollWidth <= 0) return;
  const scale = Math.min(1, clientWidth / scrollWidth);
  if (scale >= 1) return;
  target.style.overflow = "hidden";
  target.style.height = `${String(scrollHeight * scale)}px`;
  for (const child of target.children) {
    if (!(child instanceof HTMLElement)) continue;
    child.style.width = `${String(scrollWidth)}px`;
    child.style.transform = `scale(${String(scale)})`;
    child.style.transformOrigin = "top left";
  }
}

/**
 * The nearest ancestor's opaque background, so a capture of a region whose own background is transparent (most dialog bodies) doesn't export as a transparent PNG that looks broken on light chat clients.
 */
function resolveOpaqueBackgroundColor(node: HTMLElement): string {
  let el: HTMLElement | null = node;
  while (el !== null) {
    const bg = getComputedStyle(el).backgroundColor;
    if (bg !== "" && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)") {
      return bg;
    }
    el = el.parentElement;
  }
  return "#ffffff";
}
