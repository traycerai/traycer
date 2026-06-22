import { nativeTheme, session } from "electron";
import { log } from "./logger";

export interface AccessibilityThemeSnapshot {
  readonly prefersReducedTransparency: boolean;
  readonly shouldUseHighContrastColors: boolean;
  readonly shouldUseDarkColors: boolean;
  readonly shouldUseInvertedColorScheme: boolean;
}

/**
 * Subscribes to OS-level theme/accessibility changes. The renderer already
 * follows `prefers-color-scheme` via CSS, but `prefersReducedTransparency`
 * (macOS Reduce Transparency, Windows Transparency Effects) and
 * `shouldUseHighContrastColors` aren't exposed to CSS - we surface them
 * here so the renderer can opt out of vibrancy/blur and bump contrast.
 */
export function installAccessibilityThemeForwarder(
  onUpdate: (snapshot: AccessibilityThemeSnapshot) => void,
): void {
  let last: AccessibilityThemeSnapshot | null = null;
  const emit = (): void => {
    const next: AccessibilityThemeSnapshot = {
      prefersReducedTransparency: nativeTheme.prefersReducedTransparency,
      shouldUseHighContrastColors: nativeTheme.shouldUseHighContrastColors,
      shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
      shouldUseInvertedColorScheme: nativeTheme.shouldUseInvertedColorScheme,
    };
    if (
      last !== null &&
      last.prefersReducedTransparency === next.prefersReducedTransparency &&
      last.shouldUseHighContrastColors === next.shouldUseHighContrastColors &&
      last.shouldUseDarkColors === next.shouldUseDarkColors &&
      last.shouldUseInvertedColorScheme === next.shouldUseInvertedColorScheme
    ) {
      return;
    }
    last = next;
    onUpdate(next);
  };
  nativeTheme.on("updated", emit);
  // Emit once at install so the renderer hydrates without an extra
  // request/response round-trip.
  emit();
}

export function readAccessibilityTheme(): AccessibilityThemeSnapshot {
  return {
    prefersReducedTransparency: nativeTheme.prefersReducedTransparency,
    shouldUseHighContrastColors: nativeTheme.shouldUseHighContrastColors,
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
    shouldUseInvertedColorScheme: nativeTheme.shouldUseInvertedColorScheme,
  };
}

/**
 * Logs every download initiated by any session. `autoUpdater` already
 * self-reports its progress; this catches everything else (drag-dropped
 * URLs, runaway `<a download>` from a renderer bug, etc.). Logged at
 * info level - flip to warn if it becomes noisy.
 */
export function installDownloadObserver(): void {
  session.defaultSession.on("will-download", (_event, item, webContents) => {
    log.info("[downloads] will-download", {
      url: item.getURL(),
      filename: item.getFilename(),
      mimeType: item.getMimeType(),
      totalBytes: item.getTotalBytes(),
      initiatedBy: webContents.getURL(),
    });
    item.on("done", (_doneEvent, state) => {
      log.info("[downloads] done", {
        url: item.getURL(),
        state,
        receivedBytes: item.getReceivedBytes(),
      });
    });
  });
}
