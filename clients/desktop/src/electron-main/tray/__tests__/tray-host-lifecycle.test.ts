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

const PROMISES: Readonly<Record<HostLifecycleMode, string>> = {
  background: "keeps running after quit",
  linked: "stops with app",
  ask: "asks when you quit",
  "stop-if-idle": "stops at quit if idle",
  none: "off from next launch",
};

describe("trayHostLifecyclePresentation", () => {
  it("lanes off: 'No local host' and nothing offered, for every mode and running state", () => {
    for (const mode of MODES) {
      for (const hostRunning of [true, false]) {
        expect(
          trayHostLifecyclePresentation({
            lanesActive: false,
            mode,
            hostRunning,
            foregroundRun: false,
          }),
        ).toEqual({
          line: "No local host",
          offerQuitAndStopHost: false,
          offerRestartHost: false,
        });
      }
    }
  });

  for (const mode of MODES) {
    for (const hostRunning of [true, false]) {
      it(`lanes on / ${mode} / running=${String(hostRunning)}`, () => {
        const state = hostRunning ? "running" : "not running";
        expect(
          trayHostLifecyclePresentation({
            lanesActive: true,
            mode,
            hostRunning,
            foregroundRun: false,
          }),
        ).toEqual({
          line: `Host: ${state} · ${PROMISES[mode]}`,
          // Linked's plain Quit already stops; none has nothing to stop; a
          // dead host has nothing to stop either.
          offerQuitAndStopHost:
            hostRunning && mode !== "linked" && mode !== "none",
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

// A dead local host must never offer "Quit and Stop Host" - there is
// nothing to stop.
describe("a dead local host is never offered Quit and Stop Host (tray)", () => {
  const offerableModes: readonly HostLifecycleMode[] = [
    "ask",
    "stop-if-idle",
    "background",
  ];
  for (const mode of offerableModes) {
    it(`${mode}, hostRunning:false: offerQuitAndStopHost is false`, () => {
      expect(
        trayHostLifecyclePresentation({
          lanesActive: true,
          mode,
          hostRunning: false,
          foregroundRun: false,
        }).offerQuitAndStopHost,
      ).toBe(false);
    });
  }
});

// "The desktop leaves a host that a person started in a terminal
// untouched; the mode governs the service run only." A foreground run is
// hidden from the tray entirely - neither offer applies to a host the
// service does not own, and the line says so. On head,
// `trayHostLifecyclePresentation` has no `foregroundRun` input at all: the
// line still reads the mode's promise, `offerQuitAndStopHost` follows the
// existing formula (already false for `linked`/`none`), and
// `offerRestartHost` is unconditionally `true` whenever lanes are active -
// The review ruled Restart Host is hidden for a foreground run too.
describe("a foreground run is hidden from the tray", () => {
  const foregroundModes: readonly HostLifecycleMode[] = [
    "background",
    "ask",
    "stop-if-idle",
    "linked",
  ];
  for (const mode of foregroundModes) {
    it(`lanes on / ${mode} / running / foreground: the terminal line, no Quit-and-Stop, no Restart`, () => {
      const result = trayHostLifecyclePresentation({
        lanesActive: true,
        mode,
        hostRunning: true,
        foregroundRun: true,
      });
      // RED for every mode: the line still reads the mode's promise today.
      expect(result.line).toBe("Host: running · started in a terminal");
      // RED for ask/stop-if-idle (today's formula offers it for a running,
      // non-linked/none mode); already `false` for linked, so linked is not
      // red on this assertion, only on the line.
      expect(result.offerQuitAndStopHost).toBe(false);
      // RED for every mode (the review's ruling): Restart Host is unconditionally
      // `true` on head whenever lanes are active.
      expect(result.offerRestartHost).toBe(false);
    });
  }

  for (const mode of MODES) {
    it(`hostRunning:false, foreground: unchanged from today (${mode})`, () => {
      const state = "not running";
      expect(
        trayHostLifecyclePresentation({
          lanesActive: true,
          mode,
          hostRunning: false,
          foregroundRun: true,
        }),
      ).toEqual({
        line: `Host: ${state} · ${PROMISES[mode]}`,
        offerQuitAndStopHost: false,
        offerRestartHost: true,
      });
    });
  }
});
