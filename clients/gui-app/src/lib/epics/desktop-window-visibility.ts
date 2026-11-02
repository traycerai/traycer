import {
  setDesktopWindowOnScreen,
  setDesktopWindowOnScreenReporting,
} from "@/lib/dom/document-visibility";
import { createBoundedRetry } from "@/lib/epics/bounded-retry";
import type { DesktopWindowsBridge } from "@/lib/windows/types";

/**
 * Feed the desktop shell's "is this window on screen" answer into
 * `lib/dom/document-visibility.ts`, which renderer parking and the cross-window
 * report both read.
 *
 * Main watches the window's `minimize` / `restore` / `show` / `hide`
 * transitions and pushes the boolean here; this module only carries it across.
 * Once it has answered, that answer ALONE decides whether the window holds
 * its tasks' host state (`isWindowOnScreen`): Page Visibility also goes hidden
 * for a macOS window that is merely covered, and parking a covered window
 * re-opens its tasks on every return. It also keeps rendering honest for the
 * window a WebRTC video plane keeps drawing unseen (#1613), whose DOM
 * visibility is pinned to "visible" through minimise and hide.
 *
 * Optional and capability-probed like `epicVisibility`: a preload built before
 * this channel existed has no `windowVisibility`, and absent it the shell does
 * not report, so `isWindowOnScreen` stays on Page Visibility rather than
 * failing.
 *
 * ## The startup read, and the two ways it can lie
 *
 * `snapshot()` is the startup read - main's replay fires on the preload's
 * synchronous `windowId` read, before this effect subscribes - and a window
 * installed while minimised is the case it exists for. Two rules, both learnt
 * from the `epicVisibility` snapshot leg:
 *
 * 1. AN EVENT SUPERSEDES IT. A snapshot still in flight when an `onChange`
 *    lands is older than that event, and applying it afterwards would put the
 *    older answer back - a late `false` over a restore parks an epic the user
 *    is looking at, a late `true` over a minimise un-hides one. Once an event
 *    has been seen the snapshot's answer is never applied, and its retry is
 *    cancelled, because the fact arrived by the better route.
 * 2. A FAILURE IS RETRIED, bounded. "The next edge corrects it" is not a
 *    correction for the window this feature exists to reclaim: a window that
 *    was minimised at startup and then left alone produces no further edge,
 *    so a single failed read would advertise its epics and hold them resident
 *    indefinitely. The retry stops on its own once an event supplies the
 *    answer, and teardown invalidates a completion still in flight.
 */
export function installDesktopWindowVisibility(
  bridge: DesktopWindowsBridge,
): () => void {
  const channel = bridge.windowVisibility;
  if (channel === undefined) return () => undefined;
  // Main becomes the ONLY input to `isWindowOnScreen` once it has answered,
  // and not before: until then the default "on screen" is no answer, and a
  // window started minimised whose snapshot keeps failing would otherwise
  // never park and keep claiming its epics. Page Visibility decides meanwhile.
  const adopt = (onScreen: boolean): void => {
    setDesktopWindowOnScreen(onScreen);
    setDesktopWindowOnScreenReporting(true);
  };
  const lifecycle = { cancelled: false, eventSeen: false };
  // Behind a call so the compiler cannot narrow the flags across the `await`
  // below (same reason as the cross-window snapshot leg).
  const snapshotSuperseded = (): boolean =>
    lifecycle.cancelled || lifecycle.eventSeen;
  const snapshotLeg = createBoundedRetry(
    "window visibility snapshot",
    async () => {
      if (snapshotSuperseded()) return;
      const onScreen = await channel.snapshot();
      if (snapshotSuperseded()) return;
      adopt(onScreen);
    },
  );
  const subscription = channel.onChange((onScreen) => {
    if (lifecycle.cancelled) return;
    lifecycle.eventSeen = true;
    snapshotLeg.cancel();
    adopt(onScreen);
  });
  snapshotLeg.restart();
  return () => {
    lifecycle.cancelled = true;
    snapshotLeg.cancel();
    subscription.dispose();
    // The renderer is leaving this bridge's lifetime; do not leave a stale
    // "hidden" behind for whatever installs next, nor a claim to report.
    setDesktopWindowOnScreen(true);
    setDesktopWindowOnScreenReporting(false);
  };
}
