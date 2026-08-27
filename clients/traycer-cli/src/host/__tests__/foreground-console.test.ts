import { describe, expect, it } from "vitest";
import {
  openForegroundConsole,
  resolveForegroundStartMode,
  type ForegroundConsoleDeps,
  type ForegroundStartModeInput,
} from "../foreground-console";
import type { LogTail, LogTailOptions } from "../log-tail";

// `resolveForegroundStartMode`: pure decision table for what `host start`
// is allowed to print. `openForegroundConsole`: the announce-then-mirror
// side effects for each mode, fully dependency-injected.

describe("resolveForegroundStartMode", () => {
  const BASE: ForegroundStartModeInput = {
    serviceManaged: false,
    json: false,
    quiet: false,
    noProgress: false,
    interactive: false,
    platform: "darwin",
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
    // `--no-progress` on its own is not a mirror gate: the mirror is log
    // content, not progress reporting, and `--quiet` is the flag that silences
    // human output.
    [
      "--no-progress alone leaves an interactive mirror alone",
      { noProgress: true, interactive: true },
      "mirror",
    ],
    // A TTY does not imply a human on Windows. Scheduled Tasks registered
    // before the launcher was hidden execute the CLI directly with a bare
    // `host start`, no identity flags, InteractiveToken and Hidden=false - so
    // Task Scheduler allocates a console and isTTY is true, and the argv is
    // byte-identical to a person typing the command. Those definitions are
    // still attested and still on machines, so Windows gets the one-shot
    // banner and not the unbounded mirror.
    [
      "win32 + interactive TTY degrades to banner-only",
      { interactive: true, platform: "win32" },
      "banner",
    ],
    ["win32 without a TTY is still silent", { platform: "win32" }, "silent"],
    [
      "win32 + serviceManaged is still silent",
      { serviceManaged: true, interactive: true, platform: "win32" },
      "silent",
    ],
    [
      "linux + interactive TTY still mirrors",
      { interactive: true, platform: "linux" },
      "mirror",
    ],
    ["quiet, interactive TTY", { quiet: true, interactive: true }, "silent"],
    ["quiet, non-interactive", { quiet: true }, "silent"],
    ["interactive TTY, no other flags", { interactive: true }, "mirror"],
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
    const platforms: NodeJS.Platform[] = ["darwin", "linux", "win32"];
    for (const json of [false, true]) {
      for (const quiet of [false, true]) {
        for (const noProgress of [false, true]) {
          for (const interactive of [false, true]) {
            for (const platform of platforms) {
              expect(
                resolveForegroundStartMode({
                  serviceManaged: true,
                  json,
                  quiet,
                  noProgress,
                  interactive,
                  platform,
                }),
              ).toBe("silent");
            }
          }
        }
      }
    }
  });
});

function makeTailStub(): {
  stub: LogTail;
  startCalls: LogTailOptions[];
  stopCalls: number;
  drainSyncCalls: number;
} {
  const startCalls: LogTailOptions[] = [];
  let stopCalls = 0;
  let drainSyncCalls = 0;
  const stub: LogTail = {
    stop: () => {
      stopCalls += 1;
    },
    drainSync: () => {
      drainSyncCalls += 1;
    },
  };
  return {
    stub,
    startCalls,
    get stopCalls() {
      return stopCalls;
    },
    get drainSyncCalls() {
      return drainSyncCalls;
    },
  };
}

describe("openForegroundConsole", () => {
  it("mirror mode: writes a banner naming the log path, Ctrl-C, and the service-start pointer BEFORE any tail bytes, then forwards bytes verbatim; close() stops and drain-syncs", () => {
    const written: string[] = [];
    const byteChunks: Buffer[] = [];
    const onBytesCalls: Array<(chunk: Buffer) => void> = [];
    const tailControl = makeTailStub();

    const deps: Partial<ForegroundConsoleDeps> = {
      logPath: () => "/tmp/host.log",
      writeText: (text) => written.push(text),
      writeBytes: (chunk) => byteChunks.push(chunk),
      startTail: (options) => {
        tailControl.startCalls.push(options);
        onBytesCalls.push(options.onBytes);
        return tailControl.stub;
      },
      now: () => "2026-08-27T00:00:00.000Z",
    };

    const console = openForegroundConsole(
      { environment: "production", mode: "mirror" },
      deps,
    );

    // Banner precedes any tail activity.
    expect(written).toHaveLength(1);
    const banner = written[0] ?? "";
    expect(banner).toContain("/tmp/host.log");
    expect(banner).toContain("Ctrl-C");
    expect(banner).toContain("traycer host service start");
    expect(byteChunks).toHaveLength(0);

    // Bytes forwarded verbatim through writeBytes, not re-rendered.
    expect(onBytesCalls).toHaveLength(1);
    const chunk = Buffer.from("raw host log bytes\n");
    onBytesCalls[0]?.(chunk);
    expect(byteChunks).toEqual([chunk]);

    console.close();
    expect(tailControl.stopCalls).toBe(1);
    expect(tailControl.drainSyncCalls).toBe(1);
  });

  // The Windows degradation. The banner is one-shot and a few lines long, so
  // it is harmless even in a legacy Scheduled Task's console; the mirror polls
  // and reads for the whole life of a supervisor that can run for weeks, so it
  // must not start where interactivity cannot be established.
  it("banner mode: announces and points at 'host logs --follow', but starts NO tail", () => {
    const written: string[] = [];
    const byteChunks: Buffer[] = [];
    const tailControl = makeTailStub();

    const deps: Partial<ForegroundConsoleDeps> = {
      logPath: () => "/tmp/host.log",
      writeText: (text) => written.push(text),
      writeBytes: (chunk) => byteChunks.push(chunk),
      startTail: (options) => {
        tailControl.startCalls.push(options);
        return tailControl.stub;
      },
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

    // The whole point: no polling, no reads, no bytes.
    expect(tailControl.startCalls).toHaveLength(0);
    expect(byteChunks).toHaveLength(0);

    console.close();
    expect(tailControl.stopCalls).toBe(0);
    expect(tailControl.drainSyncCalls).toBe(0);
  });

  it("events mode (--json): emits exactly one NDJSON progress line with stage host-supervise, and never calls writeBytes", () => {
    const written: string[] = [];
    const byteChunks: Buffer[] = [];

    const deps: Partial<ForegroundConsoleDeps> = {
      logPath: () => "/tmp/host.log",
      writeText: (text) => written.push(text),
      writeBytes: (chunk) => byteChunks.push(chunk),
      startTail: () => {
        throw new Error("events mode must never start a tail");
      },
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
    expect(byteChunks).toHaveLength(0);

    console.close();
    expect(byteChunks).toHaveLength(0);
  });

  it("silent mode: writes nothing, starts no tail, and close() is a no-op", () => {
    const written: string[] = [];
    let startTailCalled = false;

    const deps: Partial<ForegroundConsoleDeps> = {
      logPath: () => "/tmp/host.log",
      writeText: (text) => written.push(text),
      writeBytes: () => undefined,
      startTail: () => {
        startTailCalled = true;
        throw new Error("silent mode must never start a tail");
      },
      now: () => "2026-08-27T00:00:00.000Z",
    };

    const console = openForegroundConsole(
      { environment: "production", mode: "silent" },
      deps,
    );

    expect(written).toHaveLength(0);
    expect(startTailCalled).toBe(false);
    expect(() => console.close()).not.toThrow();
    expect(written).toHaveLength(0);
  });
});
