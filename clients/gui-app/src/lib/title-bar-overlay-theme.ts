/**
 * Keeps the Windows native window controls (min/max/close) in sync with the
 * active theme.
 *
 * On Windows the frameless shell hands Chromium's Window Controls Overlay the
 * button colors via Electron's `titleBarOverlay`. Those colors are static once
 * the `BrowserWindow` is created, so without this bridge the controls stay on
 * the dark launch defaults and clash with a light theme (or a differently-
 * colored preset). This module re-derives the overlay colors from the live CSS
 * cascade on every theme change and pushes them to main, which calls
 * `setTitleBarOverlay`.
 *
 * Imperative module-load installer (mirrors `theme-applier.ts` and
 * `window-controls-overlay.ts`): it subscribes outside React so the native
 * controls update in lockstep with the DOM cascade. On the browser shell (no
 * `window.runnerHost`) and on macOS/Linux (no overlay-color surface) the push
 * target is absent, so the module no-ops.
 */

import { deriveTitleBarOverlayColors } from "@/lib/title-bar-overlay-colors";
import { subscribeResolvedTheme } from "@/lib/theme-applier";

interface TitleBarOverlaySink {
  setTitleBarOverlay(color: string, symbolColor: string): void;
}

interface RunnerHostWithOverlay {
  readonly platform?: {
    readonly windowEx?: Partial<TitleBarOverlaySink>;
  };
}

function getOverlaySink(): TitleBarOverlaySink | null {
  if (typeof window === "undefined") return null;
  const runnerHost = (window as { runnerHost?: RunnerHostWithOverlay })
    .runnerHost;
  const windowEx = runnerHost?.platform?.windowEx;
  if (
    windowEx === undefined ||
    typeof windowEx.setTitleBarOverlay !== "function"
  ) {
    return null;
  }
  return windowEx as TitleBarOverlaySink;
}

let installed = false;

function install(): void {
  if (installed) return;
  installed = true;
  if (typeof document === "undefined") return;
  const sink = getOverlaySink();
  if (sink === null) return;
  const push = (): void => {
    const { color, symbolColor } = deriveTitleBarOverlayColors(document);
    sink.setTitleBarOverlay(color, symbolColor);
  };
  // Sync the launch-time dark defaults to the persisted theme immediately, then
  // track every subsequent theme-mode / preset change.
  push();
  subscribeResolvedTheme(push);
}

install();
