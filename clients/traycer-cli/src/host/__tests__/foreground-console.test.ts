import { describe, expect, it } from "vitest";
import {
  openForegroundConsole,
  resolveForegroundStartMode,
  type ForegroundConsoleDeps,
  type ForegroundStartModeInput,
} from "../foreground-console";

// `resolveForegroundStartMode`: pure decision table for what `host start` is
// allowed to print. `openForegroundConsole`: the announce side effects for each
// mode, fully dependency-injected.

describe("resolveForegroundStartMode", () => {
  const BASE: ForegroundStartModeInput = {
    serviceManaged: false,
    json: false,
    quiet: false,
    noProgress: false,
    interactive: false,
  };

  it.each<[string, Partial<ForegroundStartModeInput>, string]>([
    [
      "serviceManaged + interactive TTY + no --quiet",
      { serviceManaged: true, interactive: true },
      "silent",
    ],
    ["serviceManaged + json", { serviceManaged: true, json: true }, "silent"],
    ["serviceManaged + quiet", { serviceManaged: true, quiet: true }, "silent"],
    ["serviceManaged alone", { serviceManaged: true }, "silent"],
    [
      "json wins over an interactive TTY",
      { json: true, interactive: true },
      "events",
    ],
    ["json, non-interactive", { json: true }, "events"],
    // `--quiet` suppresses HUMAN output, not the structured event - matching
    // the runner, whose JSON progress path checks `noProgress` alone.
    [
      "json + quiet still emits the lifecycle event",
      { json: true, quiet: true },
      "events",
    ],
    // The only structured thing this command emits is a `progress` event, so
    // `--no-progress` - documented as "suppress progress events" - has to
    // suppress it. Without this, `--json --no-progress` put a
    // `type: "progress"` line on the stdout of automation that asked for none.
    [
      "json + --no-progress suppresses the lifecycle event",
      { json: true, noProgress: true },
      "silent",
    ],
    [
      "json + --no-progress, interactive TTY",
      { json: true, noProgress: true, interactive: true },
      "silent",
    ],
    // `--no-progress` targets the structured event, not the human banner;
    // `--quiet` is the flag that silences human output.
    [
      "--no-progress alone leaves the interactive banner alone",
      { noProgress: true, interactive: true },
      "banner",
    ],
    ["quiet, interactive TTY", { quiet: true, interactive: true }, "silent"],
    ["quiet, non-interactive", { quiet: true }, "silent"],
    ["interactive TTY, no other flags", { interactive: true }, "banner"],
    ["non-interactive, no other flags", {}, "silent"],
  ])("%s -> %s", (_name, overrides, expected) => {
    expect(resolveForegroundStartMode({ ...BASE, ...overrides })).toBe(
      expected,
    );
  });

  // serviceManaged is checked FIRST and unconditionally - it is positive
  // evidence a service manager produced the invocation, so it must win over
  // every other combination, not just the ones above.
  it("serviceManaged is silent across the full remaining flag matrix", () => {
    for (const json of [false, true]) {
      for (const quiet of [false, true]) {
        for (const noProgress of [false, true]) {
          for (const interactive of [false, true]) {
            expect(
              resolveForegroundStartMode({
                serviceManaged: true,
                json,
                quiet,
                noProgress,
                interactive,
              }),
            ).toBe("silent");
          }
        }
      }
    }
  });
});

describe("openForegroundConsole", () => {
  // There is no mirroring mode at all: writing arbitrary log volume from the
  // supervisor's own event-loop thread blocks on a TTY (measured: 64 KiB into
  // an unread PTY delayed a SIGINT handler past 1.5s), which would stop Ctrl-C
  // reaching the host. The banner carries everything the audit asked for and
  // points at `host logs --follow`, which streams from a process that is not
  // supervising anything.
  it("banner mode: announces once and points at 'host logs --follow'", () => {
    const written: string[] = [];

    const deps: Partial<ForegroundConsoleDeps> = {
      logPath: () => "/tmp/host.log",
      writeText: (text) => written.push(text),
      now: () => "2026-08-27T00:00:00.000Z",
    };

    const console = openForegroundConsole(
      { environment: "production", mode: "banner" },
      deps,
    );

    expect(written).toHaveLength(1);
    const banner = written[0] ?? "";
    expect(banner).toContain("/tmp/host.log");
    expect(banner).toContain("Ctrl-C");
    expect(banner).toContain("traycer host logs --follow");
    expect(banner).toContain("traycer host service start");

    console.close();
  });

  it("events mode (--json): emits exactly one NDJSON progress line with stage host-supervise", () => {
    const written: string[] = [];

    const deps: Partial<ForegroundConsoleDeps> = {
      logPath: () => "/tmp/host.log",
      writeText: (text) => written.push(text),
      now: () => "2026-08-27T00:00:00.000Z",
    };

    const console = openForegroundConsole(
      { environment: "production", mode: "events" },
      deps,
    );

    expect(written).toHaveLength(1);
    const line = (written[0] ?? "").trimEnd();
    expect(line.split("\n")).toHaveLength(1);
    const parsed: unknown = JSON.parse(line);
    expect(parsed).toMatchObject({
      type: "progress",
      stage: "host-supervise",
    });

    console.close();
  });

  it("silent mode: writes nothing and close() is a no-op", () => {
    const written: string[] = [];

    const deps: Partial<ForegroundConsoleDeps> = {
      logPath: () => "/tmp/host.log",
      writeText: (text) => written.push(text),
      now: () => "2026-08-27T00:00:00.000Z",
    };

    const console = openForegroundConsole(
      { environment: "production", mode: "silent" },
      deps,
    );

    expect(written).toHaveLength(0);
    expect(() => console.close()).not.toThrow();
    expect(written).toHaveLength(0);
  });
});
