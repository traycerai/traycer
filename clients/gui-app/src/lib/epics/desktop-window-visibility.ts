import { setDesktopWindowOnScreen } from "@/lib/dom/document-visibility";
import { appLogger } from "@/lib/logger";
import type { DesktopWindowsBridge } from "@/lib/windows/types";

/**
 * Feed the desktop shell's "is this window on screen" answer into
 * `lib/dom/document-visibility.ts`, which renderer parking and the cross-window
 * report both read.
 *
 * Needed because the Page Visibility API is inert on the desktop: every window
 * runs with `backgroundThrottling: false`, which keeps `visibilityState` at
 * `"visible"` through minimise and hide. Main watches the BrowserWindow's own
 * `minimize` / `restore` / `show` / `hide` transitions and pushes the boolean
 * here; this module only carries it across.
 *
 * Optional and capability-probed like `epicVisibility`: a preload built before
 * this channel existed has no `windowVisibility`, and absent it the answer
 * stays "visible", which is the pre-channel behaviour (parking waits for a
 * tab hide) rather than a failure.
 *
 * The `snapshot()` leg is the startup read - main's replay fires on the
 * preload's synchronous `windowId` read, before this effect subscribes - and a
 * window installed while minimised is the case it exists for. A failed
 * snapshot is not retried: the answer it would have carried is corrected by
 * this window's next minimise/restore edge, and the failure direction
 * ("visible") only defers a reclaim.
 */
export function installDesktopWindowVisibility(
  bridge: DesktopWindowsBridge,
): () => void {
  const channel = bridge.windowVisibility;
  if (channel === undefined) return () => undefined;
  let cancelled = false;
  const subscription = channel.onChange((onScreen) => {
    if (cancelled) return;
    setDesktopWindowOnScreen(onScreen);
  });
  void channel
    .snapshot()
    .then((onScreen) => {
      if (cancelled) return;
      setDesktopWindowOnScreen(onScreen);
    })
    .catch((error: unknown) => {
      if (cancelled) return;
      appLogger.warn("[epic-visibility] window visibility snapshot failed", {
        error: error instanceof Error ? error.message : "unknown error",
      });
    });
  return () => {
    cancelled = true;
    subscription.dispose();
    // The renderer is leaving this bridge's lifetime; do not leave a stale
    // "hidden" behind for whatever installs next.
    setDesktopWindowOnScreen(true);
  };
}
