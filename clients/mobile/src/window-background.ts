import { registerPlugin } from "@capacitor/core";

export interface WindowBackgroundPluginSlice {
  set(options: WindowBands): Promise<void>;
}

export const WindowBackground =
  registerPlugin<WindowBackgroundPluginSlice>("WindowBackground");

export type WindowBarStyle = "DARK" | "LIGHT";

/**
 * The status bar's band, carried `topDepth` CSS pixels down the page so a side
 * band beside the header matches it, and the bands beside and below the rest.
 */
export interface WindowBands {
  readonly top: string;
  readonly topDepth: number;
  readonly rest: string;
}

interface EdgeRead {
  readonly layers: readonly string[];
  readonly bottom: number;
}

export interface WindowBackgroundSyncDeps {
  readonly document: Document;
  readonly setBackground: (bands: WindowBands) => void;
  readonly setBarStyle: (style: WindowBarStyle) => void;
  /** Paints CSS colours over each other, bottom first, and reads back `#rrggbb`. */
  readonly toHex: (layers: readonly string[]) => string;
}

/** Sign-in and the tour are drawn on the brand's dark ground in every theme. */
const DARK_GROUND_SURFACE = "[data-full-bleed-surface],[data-boot-ground]";

/** The WCAG relative luminance where black and white text contrast equally. */
const DARK_LUMINANCE_LIMIT = 0.179;

function channel(hex: string, start: number): number {
  const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function barStyleForBackground(hex: string): WindowBarStyle {
  const luminance =
    0.2126 * channel(hex, 1) +
    0.7152 * channel(hex, 3) +
    0.0722 * channel(hex, 5);
  return luminance < DARK_LUMINANCE_LIMIT ? "DARK" : "LIGHT";
}

const NO_FILL = "rgba(0, 0, 0, 0)";

/** The first-run tip's dim is an SVG fill that touches pass through. */
const TIP_DIM =
  ".first-task-coachmark-dim:not([data-state=exiting]) .first-task-coachmark-dim-fill";

/** Computed colours drop an alpha of 1, so any alpha left means see-through. */
function isOpaque(color: string): boolean {
  return !color.startsWith("rgba(") && !color.includes("/");
}

/** The fills that show at a point, bottom first, ending at any scrim over them. */
function readAt(document: Document, x: number, y: number): EdgeRead | null {
  const view = document.defaultView;
  if (view === null) return null;
  const tipDim = document.querySelector(TIP_DIM);
  const layers = tipDim === null ? [] : [view.getComputedStyle(tipDim).fill];
  for (const element of document.elementsFromPoint(x, y)) {
    const color = view.getComputedStyle(element).backgroundColor;
    if (color === NO_FILL) continue;
    layers.unshift(color);
    if (isOpaque(color)) {
      return { layers, bottom: element.getBoundingClientRect().bottom };
    }
  }
  return null;
}

/**
 * A newer web view runs edge to edge and `#root` pads for the bars itself, so
 * the page draws the bands. Its top one is the ground behind the header, but a
 * side one has to change colour where the header ends, as the native ones do.
 * Only those strips are painted, so nothing shows through to the content. A dim
 * over the page covers them already, so a dim's own read leaves them alone.
 */
function paintRootSideStrips(
  rootElement: HTMLElement,
  styles: CSSStyleDeclaration,
  top: EdgeRead,
  rest: EdgeRead,
): void {
  const [topGround] = top.layers;
  const [restGround] = rest.layers;
  if (top.layers.length > 1 || rest.layers.length > 1) return;
  if (topGround === undefined || restGround === undefined) return;
  const strip = `linear-gradient(${topGround} ${top.bottom}px, ${restGround} ${top.bottom}px)`;
  rootElement.style.background = [
    `${strip} left / ${styles.paddingLeft} 100% no-repeat`,
    `${strip} right / ${styles.paddingRight} 100% no-repeat`,
  ].join();
}

/**
 * Keeps the native window in step with what the page draws at its edge: the
 * area around the page where an older web view pads for the bars, and the
 * status bar's icons, which otherwise follow the system theme and not the
 * app's. No token answers for every screen: the phone header sits on one ground
 * and a chat's content on another, so the page itself is read at the middle of
 * its top edge, below any band `#root` pads for, and at its bottom right corner, where list rows stop short, or
 * at the bottom's middle when a drawer or sheet covers it. A dialog's dim only
 * covers the page, so it is read and painted on the bands too.
 * The theme lives on `<html>`, as does the fact that the menu drawer has settled,
 * the surfaces come and go, a dim fades in after its surface mounts, and a rotation or the keyboard moves what sits at an edge,
 * so all of those are watched; a change costs two hit tests per frame, and a colour is resolved and the
 * native side told only when one of those reads changes.
 */
export function startWindowBackgroundSync(
  deps: WindowBackgroundSyncDeps,
): void {
  const { document } = deps;
  const root = document.documentElement;
  const View = document.defaultView;
  if (View === null) return;
  let applied: string | null = null;
  const sync = (): void => {
    let top: EdgeRead | null;
    let rest: EdgeRead | null;
    const rootElement = document.getElementById("root");
    const rootStyles =
      rootElement === null ? null : View.getComputedStyle(rootElement);
    const onDarkGround = document.querySelector(DARK_GROUND_SURFACE) !== null;
    if (!onDarkGround) {
      const middle = View.innerWidth / 2;
      const bottom = View.innerHeight - 1;
      const overDialog =
        document.elementFromPoint(middle, bottom)?.closest("[role=dialog]") !=
        null;
      top = readAt(
        document,
        middle,
        Number.parseFloat(rootStyles?.paddingTop ?? "0") || 0,
      );
      const right =
        View.innerWidth -
        1 -
        (Number.parseFloat(rootStyles?.paddingRight ?? "0") || 0);
      rest = readAt(document, overDialog ? middle : right, bottom);
    } else {
      const styles = View.getComputedStyle(root);
      top = {
        layers: [styles.getPropertyValue("--color-zinc-950")],
        bottom: 0,
      };
      rest = top;
    }
    if (top === null || rest === null) return;
    const read = [
      top.layers.join(),
      top.bottom,
      rest.layers.join(),
      rootStyles?.padding,
    ].join("|");
    if (read === applied) return;
    applied = read;
    if (rootElement !== null && rootStyles !== null) {
      if (onDarkGround) rootElement.style.removeProperty("background");
      else paintRootSideStrips(rootElement, rootStyles, top, rest);
    }
    const topHex = deps.toHex(top.layers);
    deps.setBackground({
      top: topHex,
      topDepth: top.bottom,
      rest: deps.toHex(rest.layers),
    });
    deps.setBarStyle(barStyleForBackground(topHex));
  };
  let scheduled = false;
  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    View.requestAnimationFrame(() => {
      scheduled = false;
      sync();
    });
  };
  const observer = new View.MutationObserver(schedule);
  observer.observe(root, {
    attributes: true,
    attributeFilter: ["class", "style", "data-theme", "data-mobile-menu-open"],
  });
  observer.observe(document.body, { childList: true, subtree: true });
  View.addEventListener("resize", schedule);
  document.addEventListener("transitionend", schedule, { capture: true });
  document.addEventListener("animationend", schedule, { capture: true });
  sync();
}

/** The browser's own parser and blending: themes hold `oklch()` as well as hex. */
export function cssLayersToHex(
  layers: readonly string[],
  document: Document,
): string {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) return "#000000";
  for (const layer of layers) {
    context.fillStyle = layer;
    context.fillRect(0, 0, 1, 1);
  }
  const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
  const hex = (value: number | undefined): string =>
    (value ?? 0).toString(16).padStart(2, "0");
  return `#${hex(red)}${hex(green)}${hex(blue)}`;
}
