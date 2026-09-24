import type { HostLifecycleMode } from "@traycer/protocol/config/host-lifecycle-policy";
import type { DesktopTrayHostLifecyclePresentation } from "./tray";

/**
 * What each mode promises about the host once the app quits - the second half
 * of the tray's mode line, so a Linked user sees the promise and a Background
 * user sees why the host is still running. `none` here is a `none` chosen
 * while this instance still runs the local host (the CLI wrote it, or it is
 * pending a restart): it takes effect at the next launch.
 */
const MODE_PROMISE: Readonly<Record<HostLifecycleMode, string>> = {
  background: "keeps running after quit",
  linked: "stops with app",
  ask: "asks when you quit",
  "stop-if-idle": "stops at quit if idle",
  none: "off from next launch",
};

/**
 * The tray's host lifecycle presentation.
 *
 * "Quit and Stop Host" is offered while this instance runs a local host and
 * the mode is not Linked, whose plain Quit already stops it. "Restart Host"
 * is offered while this instance runs a local host at all - the same fact
 * the app menu reads (`MenuState.offerRestartHost`).
 */
export function trayHostLifecyclePresentation(input: {
  /** Whether this instance runs the local-host lanes. */
  readonly lanesActive: boolean;
  /** The policy's mode (fresh read). */
  readonly mode: HostLifecycleMode;
  /** Whether a local host is published and reachable right now. */
  readonly hostRunning: boolean;
}): DesktopTrayHostLifecyclePresentation {
  if (!input.lanesActive) {
    return {
      line: "No local host",
      offerQuitAndStopHost: false,
      offerRestartHost: false,
    };
  }
  const state = input.hostRunning ? "running" : "not running";
  return {
    line: `Host: ${state} · ${MODE_PROMISE[input.mode]}`,
    offerQuitAndStopHost: input.mode !== "linked" && input.mode !== "none",
    offerRestartHost: true,
  };
}
