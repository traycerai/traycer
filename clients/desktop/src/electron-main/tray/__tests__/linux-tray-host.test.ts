import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LINUX_TRAY_HOST_PROBE_TIMEOUT_MS,
  probeLinuxTrayHost,
  trayVisibleAtClose,
  type TrayProbeRun,
  type TrayProbeRunner,
} from "../linux-tray-host";

// `probeLinuxTrayHost` asks a session-bus watcher whether a StatusNotifier
// host (a panel that shows tray icons) is registered right now. Every test
// in the first block injects a `TrayProbeRunner` double directly, so it
// exercises the gdbus/dbus-send decision tree without spawning a real
// process. The second block drives the REAL runner (`run: null`) against a
// mocked `node:child_process`, to pin the ENOENT -> "missing" mapping and the
// `timeout` option actually reaching `execFile`.

const GDBUS_TRUE_STDOUT = "(<true>,)\n";
const GDBUS_FALSE_STDOUT = "(<false>,)\n";
const DBUS_SEND_TRUE_STDOUT =
  "method return time=1234 sender=:1.5 -> destination=:1.6 serial=3 reply_serial=2\n   variant       boolean true\n";
const DBUS_SEND_FALSE_STDOUT =
  "method return time=1234 sender=:1.5 -> destination=:1.6 serial=3 reply_serial=2\n   variant       boolean false\n";

const GDBUS_ARGV = [
  "call",
  "--session",
  "--dest",
  "org.kde.StatusNotifierWatcher",
  "--object-path",
  "/StatusNotifierWatcher",
  "--method",
  "org.freedesktop.DBus.Properties.Get",
  "org.kde.StatusNotifierWatcher",
  "IsStatusNotifierHostRegistered",
];

const DBUS_SEND_ARGV = [
  "--session",
  "--print-reply=literal",
  "--dest=org.kde.StatusNotifierWatcher",
  "/StatusNotifierWatcher",
  "org.freedesktop.DBus.Properties.Get",
  "string:org.kde.StatusNotifierWatcher",
  "string:IsStatusNotifierHostRegistered",
];

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
}

function runnerFor(answers: Readonly<Record<string, TrayProbeRun>>): {
  readonly runner: TrayProbeRunner;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const runner: TrayProbeRunner = (command, args) => {
    calls.push({ command, args: [...args] });
    const answer = answers[command];
    if (answer === undefined) {
      throw new Error(`unexpected probe command: ${command}`);
    }
    return Promise.resolve(answer);
  };
  return { runner, calls };
}

describe("probeLinuxTrayHost (injected runner)", () => {
  it("gdbus (<true>,): true, dbus-send never called", async () => {
    const { runner, calls } = runnerFor({
      gdbus: { kind: "ok", stdout: GDBUS_TRUE_STDOUT },
    });
    await expect(probeLinuxTrayHost(runner)).resolves.toBe(true);
    expect(calls.map((call) => call.command)).toEqual(["gdbus"]);
  });

  it("gdbus (<false>,): false", async () => {
    const { runner, calls } = runnerFor({
      gdbus: { kind: "ok", stdout: GDBUS_FALSE_STDOUT },
    });
    await expect(probeLinuxTrayHost(runner)).resolves.toBe(false);
    expect(calls.map((call) => call.command)).toEqual(["gdbus"]);
  });

  it("gdbus failed: false, dbus-send NOT called", async () => {
    const { runner, calls } = runnerFor({
      gdbus: { kind: "failed" },
    });
    await expect(probeLinuxTrayHost(runner)).resolves.toBe(false);
    expect(calls.map((call) => call.command)).toEqual(["gdbus"]);
  });

  it("gdbus missing, dbus-send 'variant boolean true': true, with the exact dbus-send argv", async () => {
    const { runner, calls } = runnerFor({
      gdbus: { kind: "missing" },
      "dbus-send": { kind: "ok", stdout: DBUS_SEND_TRUE_STDOUT },
    });
    await expect(probeLinuxTrayHost(runner)).resolves.toBe(true);
    expect(calls.map((call) => call.command)).toEqual(["gdbus", "dbus-send"]);
    expect(calls[1].args).toEqual(DBUS_SEND_ARGV);
  });

  it("gdbus missing, dbus-send missing: false", async () => {
    const { runner, calls } = runnerFor({
      gdbus: { kind: "missing" },
      "dbus-send": { kind: "missing" },
    });
    await expect(probeLinuxTrayHost(runner)).resolves.toBe(false);
    expect(calls.map((call) => call.command)).toEqual(["gdbus", "dbus-send"]);
  });

  it("gdbus missing, dbus-send 'boolean false': false", async () => {
    const { runner, calls } = runnerFor({
      gdbus: { kind: "missing" },
      "dbus-send": { kind: "ok", stdout: DBUS_SEND_FALSE_STDOUT },
    });
    await expect(probeLinuxTrayHost(runner)).resolves.toBe(false);
    expect(calls.map((call) => call.command)).toEqual(["gdbus", "dbus-send"]);
  });

  it("gdbus garbage output: false", async () => {
    const { runner, calls } = runnerFor({
      gdbus: { kind: "ok", stdout: "not a boolean property reply at all" },
    });
    await expect(probeLinuxTrayHost(runner)).resolves.toBe(false);
    expect(calls.map((call) => call.command)).toEqual(["gdbus"]);
  });

  it("the exact gdbus argv", async () => {
    const { runner, calls } = runnerFor({
      gdbus: { kind: "ok", stdout: GDBUS_TRUE_STDOUT },
    });
    await probeLinuxTrayHost(runner);
    expect(calls[0].args).toEqual(GDBUS_ARGV);
  });
});

describe("probeLinuxTrayHost(null) - the real runner", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("node:child_process");
  });

  interface ExecFileCall {
    readonly command: string;
    readonly args: readonly string[];
    readonly options: Record<string, unknown>;
  }

  type ProbeModule = typeof import("../linux-tray-host");

  async function loadWithExecFile(
    respond: (call: ExecFileCall) => NodeJS.ErrnoException,
  ): Promise<{
    readonly probe: ProbeModule["probeLinuxTrayHost"];
    readonly calls: ExecFileCall[];
  }> {
    vi.resetModules();
    const calls: ExecFileCall[] = [];
    const execFileMock = vi.fn(
      (
        command: string,
        args: readonly string[],
        options: Record<string, unknown>,
        callback: (
          error: NodeJS.ErrnoException | null,
          stdout: string,
          stderr: string,
        ) => void,
      ) => {
        const call = { command, args, options };
        calls.push(call);
        callback(respond(call), "", "");
      },
    );
    vi.doMock("node:child_process", () => ({
      execFile: execFileMock,
      default: { execFile: execFileMock },
    }));
    const mod = await import("../linux-tray-host");
    return { probe: mod.probeLinuxTrayHost, calls };
  }

  function errorWithCode(code: string | undefined): NodeJS.ErrnoException {
    const error = new Error(`probe command failed`) as NodeJS.ErrnoException;
    if (code !== undefined) {
      error.code = code;
    }
    return error;
  }

  it("execFile ENOENT maps to 'missing' and falls through to dbus-send", async () => {
    const { probe, calls } = await loadWithExecFile(() =>
      errorWithCode("ENOENT"),
    );
    await expect(probe(null)).resolves.toBe(false);
    expect(calls.map((call) => call.command)).toEqual(["gdbus", "dbus-send"]);
  });

  it("a non-ENOENT execFile error maps to 'failed' and does not fall through", async () => {
    const { probe, calls } = await loadWithExecFile(() =>
      errorWithCode(undefined),
    );
    await expect(probe(null)).resolves.toBe(false);
    expect(calls.map((call) => call.command)).toEqual(["gdbus"]);
  });

  it("passes timeout: LINUX_TRAY_HOST_PROBE_TIMEOUT_MS to execFile", async () => {
    const { probe, calls } = await loadWithExecFile(() =>
      errorWithCode("ENOENT"),
    );
    await probe(null);
    expect(calls[0].options).toMatchObject({
      timeout: LINUX_TRAY_HOST_PROBE_TIMEOUT_MS,
    });
  });
});

// `trayVisibleAtClose`: no tray object is no tray anywhere (the probe is
// never asked); on Linux a constructed tray still has to be SEEN, so the
// probe decides; on every other platform a constructed tray is visible by
// construction, so the probe is never asked either.

describe("trayVisibleAtClose", () => {
  it("linux + constructed + probe true -> true", async () => {
    let probeCalls = 0;
    const result = await trayVisibleAtClose({
      platform: "linux",
      trayConstructed: true,
      probe: () => {
        probeCalls += 1;
        return Promise.resolve(true);
      },
    });
    expect(result).toBe(true);
    expect(probeCalls).toBe(1);
  });

  it("linux + constructed + probe false -> false (probe called once)", async () => {
    let probeCalls = 0;
    const result = await trayVisibleAtClose({
      platform: "linux",
      trayConstructed: true,
      probe: () => {
        probeCalls += 1;
        return Promise.resolve(false);
      },
    });
    expect(result).toBe(false);
    expect(probeCalls).toBe(1);
  });

  it("linux + not constructed -> false, probe never called", async () => {
    let probeCalls = 0;
    const result = await trayVisibleAtClose({
      platform: "linux",
      trayConstructed: false,
      probe: () => {
        probeCalls += 1;
        return Promise.resolve(true);
      },
    });
    expect(result).toBe(false);
    expect(probeCalls).toBe(0);
  });

  it("win32 + constructed -> true, probe never called", async () => {
    let probeCalls = 0;
    const result = await trayVisibleAtClose({
      platform: "win32",
      trayConstructed: true,
      probe: () => {
        probeCalls += 1;
        return Promise.resolve(false);
      },
    });
    expect(result).toBe(true);
    expect(probeCalls).toBe(0);
  });

  it("darwin + constructed -> true, probe never called", async () => {
    let probeCalls = 0;
    const result = await trayVisibleAtClose({
      platform: "darwin",
      trayConstructed: true,
      probe: () => {
        probeCalls += 1;
        return Promise.resolve(false);
      },
    });
    expect(result).toBe(true);
    expect(probeCalls).toBe(0);
  });

  it("win32 + not constructed -> false", async () => {
    let probeCalls = 0;
    const result = await trayVisibleAtClose({
      platform: "win32",
      trayConstructed: false,
      probe: () => {
        probeCalls += 1;
        return Promise.resolve(true);
      },
    });
    expect(result).toBe(false);
    expect(probeCalls).toBe(0);
  });
});
