import { use, useEffect } from "react";
import { registerReservedBrowserChords } from "@/lib/browser-view/reserved-chords-registration";
import { selectLandingTerminalSurfaceActive } from "@/components/home/terminal-panel/landing-terminal-surface-binding";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import { useTabsStore } from "@/stores/tabs/store";

export function ReservedBrowserChordsBridge() {
  const runnerHost = use(RunnerHostContext);
  // The reserved set is derived from these, so it is a SUBSCRIPTION and not a
  // one-shot read: registration is the only copy of the bindings in the guest
  // input path, and a rebind that does not reach main leaves the old chord
  // claimed and the new one going to the page.
  const bindings = useKeybindingStore((s) => s.bindings);
  // The same gate the Start Page panel registers its chord handlers under: the
  // panel's three are forwarded only while a replayed key would find one.
  const landingSurfaceActive = useTabsStore(selectLandingTerminalSurfaceActive);
  useEffect(() => {
    // BT-303: app chords outrank guest keystrokes; main replaces its whole
    // set on each call, so this is idempotent across HMR, across rebinds and
    // across surface changes.
    if (runnerHost !== null) {
      registerReservedBrowserChords(runnerHost, bindings, {
        landingSurfaceActive,
      });
    }
  }, [runnerHost, bindings, landingSurfaceActive]);
  return null;
}
