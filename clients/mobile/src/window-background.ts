import { registerPlugin } from "@capacitor/core";

export interface WindowBackgroundPluginSlice {
  set(options: { readonly color: string }): Promise<void>;
}

export const WindowBackground =
  registerPlugin<WindowBackgroundPluginSlice>("WindowBackground");

export type WindowBarStyle = "DARK" | "LIGHT";

export interface WindowBackgroundSyncDeps {
  readonly document: Document;
  readonly setBackground: (color: string) => void;
  readonly setBarStyle: (style: WindowBarStyle) => void;
  /** Resolves any CSS color the theme holds to `#rrggbb`. */
  readonly toHex: (cssColor: string) => string;
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

/**
 * Keeps the native window in step with what the page draws at its edge: the
 * area beside the page where an older web view pads for the bars, and the
 * status bar's icons, which otherwise follow the system theme and not the
 * app's. The theme lives on `<html>`, and which ground shows depends on what is
 * mounted, so both are watched; a mutation only costs one selector check and
 * one token read per frame, and the colour is resolved and the native side told
 * only when that token's value changes.
 */
export function startWindowBackgroundSync(
  deps: WindowBackgroundSyncDeps,
): void {
  const { document } = deps;
  const root = document.documentElement;
  let appliedToken: string | null = null;
  const sync = (): void => {
    const styles = document.defaultView?.getComputedStyle(root);
    if (styles === undefined) return;
    const token =
      document.querySelector(DARK_GROUND_SURFACE) === null
        ? "--canvas"
        : "--color-zinc-950";
    const value = styles.getPropertyValue(token);
    if (value === appliedToken) return;
    appliedToken = value;
    const color = deps.toHex(value);
    deps.setBackground(color);
    deps.setBarStyle(barStyleForBackground(color));
  };
  const View = document.defaultView;
  if (View === null) return;
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
    attributeFilter: ["class", "style", "data-theme"],
  });
  observer.observe(document.body, { childList: true, subtree: true });
  sync();
}

/** The browser's own parser: the themes hold `oklch()` as well as hex. */
export function cssColorToHex(cssColor: string, document: Document): string {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) return "#000000";
  context.fillStyle = cssColor;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
  const hex = (value: number | undefined): string =>
    (value ?? 0).toString(16).padStart(2, "0");
  return `#${hex(red)}${hex(green)}${hex(blue)}`;
}
