import type { CSSProperties } from "react";

// Frameless-desktop detection: Electron's preload bridge exposes
// `window.runnerHost` via `contextBridge.exposeInMainWorld`. Browser
// shells never see it. Reliable in Electron 42 with sandbox + app://
// scheme + Chromium UA reduction (UA sniffing is not).
export function isFramelessDesktop(): boolean {
  return (
    typeof window !== "undefined" &&
    Object.prototype.hasOwnProperty.call(window, "runnerHost")
  );
}

// `-webkit-app-region` isn't in the standard CSSProperties typings.
type AppRegionStyle = CSSProperties & {
  readonly WebkitAppRegion: "drag" | "no-drag";
};

export const DRAG_STYLE: AppRegionStyle = { WebkitAppRegion: "drag" };
export const NO_DRAG_STYLE: AppRegionStyle = { WebkitAppRegion: "no-drag" };

// Drag style for title-bar spacers: only frameless desktop shells use them as
// an OS drag region, and only while no title-bar overlay needs the title bar
// to receive clicks (see `useTitleBarDraggingSuppressed`).
export function titleBarSpacerStyle(
  framelessDesktop: boolean,
  dragSuppressed: boolean,
): CSSProperties | undefined {
  if (!framelessDesktop) return undefined;
  return dragSuppressed ? NO_DRAG_STYLE : DRAG_STYLE;
}

// Under a window-controls overlay, the leading padding that clears whatever
// the OS draws at the window's top-left (the macOS traffic lights). The value
// is `--window-leading-inset` (styles/window-chrome.css), so the element at
// the window's top-left corner decides who keeps the reserve.
export const WINDOW_LEADING_INSET_CLASS =
  "wco:pl-[var(--window-leading-inset)]";

// Under a window-controls overlay, the trailing padding that clears the
// native controls at the top-right (Windows and Linux): everything right of
// the title-bar area, plus a 12px gutter.
export const WINDOW_TRAILING_INSET_CLASS =
  "wco:pr-[max(12px,calc(100vw-env(titlebar-area-x,0px)-env(titlebar-area-width,100vw)+12px))]";
