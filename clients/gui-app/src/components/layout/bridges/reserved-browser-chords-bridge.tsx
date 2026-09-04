import { use, useEffect } from "react";
import { registerReservedBrowserChords } from "@/lib/browser-view/reserved-chords-registration";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";

export function ReservedBrowserChordsBridge() {
  const runnerHost = use(RunnerHostContext);
  // The reserved set is derived from these, so it is a SUBSCRIPTION and not a
  // one-shot read: registration is the only copy of the bindings in the guest
  // input path, and a rebind that does not reach main leaves the old chord
  // claimed and the new one going to the page.
  const bindings = useKeybindingStore((s) => s.bindings);
  useEffect(() => {
    // BT-303: app chords outrank guest keystrokes; main replaces its whole
    // set on each call, so this is idempotent across HMR and across rebinds.
    if (runnerHost !== null)
      registerReservedBrowserChords(runnerHost, bindings);
  }, [runnerHost, bindings]);
  return null;
}
