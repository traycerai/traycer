import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { createLinuxController, type ProcessRunner } from "../linux";
import { serviceLabelFor } from "../../label";
import { hostPidMetadataPath } from "../../../store/paths";

// PIN: `host service uninstall` over a live FOREGROUND run must not refuse on
// Linux, and Linux's uninstall never has to change to make that true - it
// only ever talks to systemd-user (`systemctl --user disable --now` /
// `daemon-reload` / `reset-failed` on the unit) and never touches a host
// process or its pid metadata directly. `leaveForegroundRun` is a field the
// Windows uninstall path is being taught to read (to skip killing a
// terminal-started host and skip removing its pid metadata); Linux's
// `uninstallService` takes the same `UninstallServiceOptions` shape but has
// no code path that reads this field at all, so passing it must be a
// complete no-op here. This test is expected GREEN against current,
// unmodified production code - it pins that fact so the Windows-focused
// change cannot silently regress Linux behind it.
//
// A real `pid.json` is written before the call (using the real path
// mechanism, `hostPidMetadataPath`) and compared byte-for-byte afterwards:
// Linux uninstall has no reason to touch it, and this proves it doesn't.
describe("Linux service uninstall - foreground-leave field is inert", () => {
  const label = serviceLabelFor("production");
  const pidMetadataPath = hostPidMetadataPath(label.environment);
  const pidMetadataBytes = JSON.stringify(
    {
      pid: 66666,
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

  it("completes uninstall with only systemctl --user calls, and leaves pid.json untouched, when leaveForegroundRun is passed", async () => {
    const calls: Array<{
      readonly command: string;
      readonly args: readonly string[];
    }> = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const controller = createLinuxController(runner);

    await expect(
      controller.uninstall({
        label,
        leaveForegroundRun: { supervisorPid: 111, hostPid: 222 },
      }),
    ).resolves.toBeUndefined();

    // Only systemctl --user, never a kill, never any process-scan command
    // (`ps`, etc). Linux uninstall reaches systemd-user only; it never
    // reaches a host process.
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.command).toBe("systemctl");
      expect(call.args[0]).toBe("--user");
      expect(["disable", "daemon-reload", "reset-failed"]).toContain(
        call.args[1],
      );
    }
    const verbs = calls.map((call) => call.args[1]);
    expect(verbs).toEqual(["disable", "daemon-reload", "reset-failed"]);

    // pid.json is untouched: exists, byte-identical to what was there before
    // the call. `leaveForegroundRun` is not read by Linux's uninstall at all.
    const afterBytes = await readFile(pidMetadataPath, "utf8");
    expect(afterBytes).toBe(pidMetadataBytes);
  });
});
