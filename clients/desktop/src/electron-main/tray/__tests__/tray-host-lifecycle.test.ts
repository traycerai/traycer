import { describe, expect, it } from "vitest";
import type { HostLifecycleMode } from "@traycer/protocol/config/host-lifecycle-policy";
import { trayHostLifecyclePresentation } from "../tray-host-lifecycle";

const MODES: readonly HostLifecycleMode[] = [
  "background",
  "linked",
  "ask",
  "stop-if-idle",
  "none",
];

describe("trayHostLifecyclePresentation", () => {
  it("lanes off: 'No local host' and nothing offered, for every mode and running state", () => {
    for (const mode of MODES) {
      for (const hostRunning of [true, false]) {
        expect(
          trayHostLifecyclePresentation({
            lanesActive: false,
            mode,
            hostRunning,
          }),
        ).toEqual({
          line: "No local host",
          offerQuitAndStopHost: false,
          offerRestartHost: false,
        });
      }
    }
  });

  const promises: Readonly<Record<HostLifecycleMode, string>> = {
    background: "keeps running after quit",
    linked: "stops with app",
    ask: "asks when you quit",
    "stop-if-idle": "stops at quit if idle",
    none: "off from next launch",
  };
  for (const mode of MODES) {
    for (const hostRunning of [true, false]) {
      it(`lanes on / ${mode} / running=${String(hostRunning)}`, () => {
        const state = hostRunning ? "running" : "not running";
        expect(
          trayHostLifecyclePresentation({
            lanesActive: true,
            mode,
            hostRunning,
          }),
        ).toEqual({
          line: `Host: ${state} · ${promises[mode]}`,
          // Linked's plain Quit already stops; none has nothing to stop.
          offerQuitAndStopHost: mode !== "linked" && mode !== "none",
          // Restart Host is offered whenever lanes are active, regardless of
          // mode - "off from next launch" `none` still runs a local host
          // THIS session, and restarting it is exactly what recovers a stuck
          // one before the pending switch takes effect.
          offerRestartHost: true,
        });
      });
    }
  }
});
