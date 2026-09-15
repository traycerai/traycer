import { useSettingsStore } from "@/stores/settings/settings-store";
import { appLogger } from "@/lib/logger";
import { deriveTitleBarOverlayColors } from "@/lib/title-bar-overlay-colors";
import { subscribeResolvedTheme } from "@/lib/theme-applier";

export interface TitleBarOverlaySink {
  setTitleBarOverlay(
    color: string,
    symbolColor: string,
    themeSource: "system" | "light" | "dark",
  ): Promise<void>;
}

/**
 * Keeps the native min/max/close controls aligned with the active
 * renderer theme. Windows and Linux desktop startup call this after preload
 * and renderer CSS are available.
 *
 * The load retry closes the startup race where the first computed-style read
 * can precede the final stylesheet cascade. Theme changes then push after the
 * theme applier has synchronously updated the document attributes.
 */
export function installTitleBarOverlayThemeSync(
  sink: TitleBarOverlaySink,
  doc: Document,
): () => void {
  let disposed = false;
  const push = (): void => {
    if (disposed) return;
    const { color, symbolColor } = deriveTitleBarOverlayColors(doc);
    void sink
      .setTitleBarOverlay(color, symbolColor, useSettingsStore.getState().theme)
      .catch((error) => {
        appLogger.error("Failed to synchronize title-bar colors", {}, error);
      });
  };

  push();
  const unsubscribeTheme = subscribeResolvedTheme(push);
  const targetWindow = doc.defaultView;
  const retryAfterLoad = (): void => {
    push();
  };
  if (doc.readyState !== "complete" && targetWindow !== null) {
    targetWindow.addEventListener("load", retryAfterLoad, { once: true });
  }

  return () => {
    disposed = true;
    unsubscribeTheme();
    targetWindow?.removeEventListener("load", retryAfterLoad);
  };
}
