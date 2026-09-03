import { use, useEffect } from "react";
import { registerReservedBrowserChords } from "@/lib/browser-view/reserved-chords-registration";
import { RunnerHostContext } from "@/providers/runner-host-context";

export function BrowserOverlayCoordinatorBridge() {
  const runnerHost = use(RunnerHostContext);
  useEffect(() => {
    // BT-303: app chords outrank guest keystrokes; main replaces its whole
    // set on each call, so this is idempotent across HMR.
    if (runnerHost !== null) registerReservedBrowserChords(runnerHost);
  }, [runnerHost]);
  return null;
}
