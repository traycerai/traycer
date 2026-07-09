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
 * controls update in lockstep with the DOM cascade. The whole bridge is
 * Windows-only - macOS draws OS-native traffic lights, Linux uses default
 * chrome, and main drops the push off `win32` - so the installer short-circuits
 * on any other OS instead of emitting IPC main would ignore. On the browser
 * shell there is no `window.runnerHost`, so the push target is absent and the
 * module no-ops there too.
 */

import { deriveTitleBarOverlayColors } from "@/lib/title-bar-overlay-colors";
import { isWindows } from "@/lib/keybindings/platform";
import { subscribeResolvedTheme } from "@/lib/theme-applier";

interface TitleBarOverlaySink {
  setTitleBarOverlay(color: string, symbolColor: string): void;
}

// Structural view of the desktop preload's `runnerHost.platform.windowEx`
// surface, typed locally so gui-app stays browser-safe and doesn't import from
// the desktop package (mirrors the sibling `desktop-*.ts` host bridges).
interface RunnerHostWindowShape {
  readonly platform:
    { readonly windowEx: TitleBarOverlaySink | undefined } | undefined;
}

function getOverlaySink(): TitleBarOverlaySink | null {
  const host = (globalThis as { runnerHost?: RunnerHostWindowShape })
    .runnerHost;
  return host?.platform?.windowEx ?? null;
}

let installed = false;

function install(): void {
  if (installed) return;
  installed = true;
  if (typeof document === "undefined") return;
  // Only Windows draws its controls from `titleBarOverlay`; elsewhere the push
  // is a no-op in main, so skip the subscription rather than churn IPC.
  if (!isWindows()) return;
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
