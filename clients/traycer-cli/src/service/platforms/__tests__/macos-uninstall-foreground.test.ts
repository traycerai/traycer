import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { createMacosController, type ProcessRunner } from "../macos";
import { serviceLabelFor } from "../../label";
import { hostPidMetadataPath } from "../../../store/paths";

// PIN: `host service uninstall` over a live FOREGROUND run must not refuse on
// macOS, and macOS's uninstall never has to change to make that true - it
// only ever talks to launchd (`launchctl print` / `bootout` of the CLI and
// SMAppService-agent labels) and never touches a host process or its pid
// metadata directly. `leaveForegroundRun` is a field the Windows uninstall
// path is being taught to read (to skip killing a terminal-started host and
// skip removing its pid metadata); macOS's `uninstallService` takes the same
// `UninstallServiceOptions` shape but has no code path that reads this field
// at all, so passing it must be a complete no-op here. This test is expected
// GREEN against current, unmodified production code - it pins that fact so
// the Windows-focused change cannot silently regress macOS behind it.
//
// A real `pid.json` is written before the call (using the real path
// mechanism, `hostPidMetadataPath`) and compared byte-for-byte afterwards:
// macOS uninstall has no reason to touch it, and this proves it doesn't.
describe("macOS service uninstall - foreground-leave field is inert", () => {
  const label = serviceLabelFor("production");
  const pidMetadataPath = hostPidMetadataPath(label.environment);
  const pidMetadataBytes = JSON.stringify(
    {
      pid: 55555,
      hostId: "foreground-pin-test-host",
      version: "9.9.9",
      websocketUrl: "ws://127.0.0.1:9999/rpc",
      startedAt: "2026-09-26T00:00:00.000Z",
    },
    null,
    2,
  );

  beforeEach(async () => {
    await mkdir(dirname(pidMetadataPath), { recursive: true });
    await writeFile(pidMetadataPath, pidMetadataBytes, "utf8");
  });

  afterEach(async () => {
    await rm(pidMetadataPath, { force: true });
  });

  it("completes uninstall with only launchctl print/bootout calls, and leaves pid.json untouched, when leaveForegroundRun is passed", async () => {
    const calls: Array<{
      readonly command: string;
      readonly args: readonly string[];
    }> = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const controller = createMacosController(runner);

    await expect(
      controller.uninstall({
        label,
        leaveForegroundRun: { supervisorPid: 111, hostPid: 222 },
      }),
    ).resolves.toBeUndefined();

    // Only launchctl, and only print/bootout - never a kill, never any
    // process-scan command (`ps`, etc). macOS uninstall reaches launchd
    // only; it never reaches a host process.
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.command).toBe("launchctl");
      expect(["print", "bootout"]).toContain(call.args[0]);
    }
    const verbs = calls.map((call) => call.args[0]);
    expect(verbs).toEqual(["print", "print", "bootout", "bootout"]);

    // pid.json is untouched: exists, byte-identical to what was there before
    // the call. `leaveForegroundRun` is not read by macOS's uninstall at all.
    const afterBytes = await readFile(pidMetadataPath, "utf8");
    expect(afterBytes).toBe(pidMetadataBytes);
  });
});
