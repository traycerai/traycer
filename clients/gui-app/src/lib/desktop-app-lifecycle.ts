import { Analytics, AnalyticsEvent } from "@/lib/analytics";

/**
 * Feature-detected access to the desktop-only `appLifecycle` namespace the
 * Electron preload installs on `window.runnerHost`. gui-app must stay
 * browser-safe, so this reads the global defensively and degrades to a plain
 * `window.close()` on shells (web / gui-app-dev) that don't expose it.
 */
interface AppLifecycleQuitBridge {
  readonly quit?: () => Promise<void>;
}

interface RunnerHostWindowShape {
  readonly appLifecycle?: AppLifecycleQuitBridge;
}

function readAppLifecycleQuit(): (() => Promise<void>) | null {
  const host = (globalThis as { runnerHost?: RunnerHostWindowShape })
    .runnerHost;
  const quit = host?.appLifecycle?.quit;
  return typeof quit === "function" ? quit : null;
}

/**
 * Quit the desktop app (the removed surface's "Quit Traycer" button). Routes
 * through Electron's normal `before-quit` flow. Falls back to closing the
 * current window outside the desktop shell.
 */
export function requestAppQuit(): void {
  Analytics.getInstance().track(AnalyticsEvent.AppQuitRequested, {
    source: "direct_ui",
  });
  const quit = readAppLifecycleQuit();
  if (quit !== null) {
    void quit();
    return;
  }
  window.close();
}
