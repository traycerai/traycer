import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";

/**
 * This renderer's desktop window id, or `null` off Electron.
 *
 * Read structurally rather than through `DesktopWindowsBridge`, and one
 * function rather than two readers, because the id is one half of an identity
 * that spans three processes and has to hold by construction:
 *
 * - desktop main mints it in its window registry and answers
 *   `RunnerHostSync.windowId` with `resolveSenderWindowId(event)`, which the
 *   preload exposes here as `windows.windowId`;
 * - the same `resolveSenderWindowId` names the window a `browser.sessions`
 *   stream is opened for, and that stream stamps it on
 *   `electronTabLifecycleReady.desktopWindowId`;
 * - the host elects native routes per scope AND window by that id, and echoes
 *   the route holding a tab's binding back as `BrowserTabInfo.boundWindowId`.
 *
 * So a tile comparing `boundWindowId` against this value is comparing the same
 * string main handed out, not two ids that merely describe the same window.
 * The whole-bridge guard in `windows-bridge-provider` is deliberately NOT
 * reused: it requires every bridge method to be present, so a preload built
 * before some unrelated method existed would resolve `null` here and silently
 * cost the tile a branch it has the fact for.
 */
export function readDesktopWindowId(
  runnerHost: IRunnerHost | null,
): string | null {
  if (!isRecord(runnerHost)) return null;
  const windows = runnerHost.windows;
  if (!isRecord(windows)) return null;
  const windowId = windows.windowId;
  return typeof windowId === "string" && windowId.length > 0 ? windowId : null;
}

/**
 * {@link readDesktopWindowId} for components. Uses the null-returning runner
 * host read so a surface rendered outside `<RunnerHostProvider>` - every
 * component suite that does not stand one up - degrades to "no window id"
 * instead of throwing.
 */
export function useDesktopWindowId(): string | null {
  return readDesktopWindowId(useRunnerHostOrNull());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
