import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createLinuxController, type ProcessRunner } from "../linux";
import { serviceManifestPath, type ServiceLabel } from "../../label";
import { ProcessRunError, type RunResult } from "../../process-runner";
import { CLI_ERROR_CODES } from "../../../runner/errors";
import { fileExists } from "../../install-binary";

/**
 * The systemd install FLOW - as opposed to the emitted artifact, which
 * `linux.test.ts` executes. Three defects fixed together, each pinned here:
 *
 *   1. no preflight: on a box with no reachable user manager (WSL with
 *      systemd disabled, `sudo su`, headless SSH) the old flow wrote the
 *      unit file FIRST and then threw a raw ProcessRunError out of
 *      `daemon-reload` - residue plus an error naming neither systemd nor
 *      WSL;
 *   2. no rollback: a failed daemon-reload/enable left the just-written
 *      unit file behind as an orphan;
 *   3. no reset-failed on uninstall: a unit that had restart-looped into
 *      `failed` kept its failed entry in the user manager after its file
 *      was deleted.
 */

// Same isolation as macos.test.ts: `serviceManifestPath` resolves under the
// real home dir, and this suite exercises real writes/removals of the
// manifest, so redirect it to a private temp dir.
const TEST_UNIT_DIR = mkdtempSync(
  join(tmpdir(), "traycer-linux-service-test-"),
);
vi.mock("../../label", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../label")>();
  return {
    ...actual,
    serviceManifestPath: (label: { readonly id: string }) =>
      join(TEST_UNIT_DIR, `${label.id}.service`),
  };
});

const label: ServiceLabel = {
  id: "ai.traycer.host.dev",
  displayName: "Traycer Host (test)",
  environment: "dev",
  devSlot: null,
};

const unitFile = (): string => serviceManifestPath(label);

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
}

function ok(): RunResult {
  return { stdout: "", stderr: "", exitCode: 0 };
}

function busError(command: string, args: readonly string[]): ProcessRunError {
  return new ProcessRunError(
    `${command} ${args.join(" ")} exited with code 1: Failed to connect to bus: No medium found`,
    command,
    args,
    1,
    "",
    "Failed to connect to bus: No medium found",
  );
}

/** A runner that records every call and fails those `failWhen` selects. */
function recordingRunner(failWhen: (call: RecordedCall) => boolean): {
  readonly calls: RecordedCall[];
  readonly runner: ProcessRunner;
} {
  const calls: RecordedCall[] = [];
  const runner: ProcessRunner = (command, args) => {
    const call: RecordedCall = { command, args };
    calls.push(call);
    if (failWhen(call)) {
      return Promise.reject(busError(command, args));
    }
    return Promise.resolve(ok());
  };
  return { calls, runner };
}

function installWith(runner: ProcessRunner): Promise<void> {
  return createLinuxController(runner).install({
    label,
    cli: { command: "/usr/local/bin/traycer", args: [] },
    enableLinger: true,
  });
}

/** The systemctl verb (or loginctl verb) of a recorded call, for sequences. */
function verbOf(call: RecordedCall): string {
  return call.command === "systemctl"
    ? (call.args[1] ?? "")
    : `${call.command}:${call.args[0] ?? ""}`;
}

afterEach(async () => {
  await rm(unitFile(), { force: true });
});

afterAll(async () => {
  await rm(TEST_UNIT_DIR, { recursive: true, force: true });
});

describe("linux service install flow", () => {
  it("refuses to install - writing NOTHING - when the user manager is unreachable, and says so", async () => {
    const { calls, runner } = recordingRunner(
      (call) => call.args[1] === "show-environment",
    );

    await expect(installWith(runner)).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: expect.stringContaining("WSL"),
    });
    // The preflight is the FIRST thing that runs, and on failure nothing
    // else does: no unit file, no daemon-reload attempt.
    expect(await fileExists(unitFile())).toBe(false);
    expect(calls.map(verbOf)).toEqual(["show-environment"]);
  });

  it("rolls the unit file back when daemon-reload fails", async () => {
    const { calls, runner } = recordingRunner(
      (call) => call.args[1] === "daemon-reload",
    );

    await expect(installWith(runner)).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: expect.stringContaining("unit file was removed"),
    });
    expect(await fileExists(unitFile())).toBe(false);
    // The rollback's own daemon-reload runs too (best-effort, tolerated),
    // so systemd is told about the removal even though the initial reload
    // is what failed.
    expect(calls.map(verbOf)).toEqual([
      "show-environment",
      "daemon-reload",
      "disable",
      "daemon-reload",
    ]);
  });

  it("rolls the unit file back - and re-reloads - when enable --now fails", async () => {
    const { calls, runner } = recordingRunner(
      (call) => call.args[1] === "enable",
    );

    await expect(installWith(runner)).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
    });
    expect(await fileExists(unitFile())).toBe(false);
    // `disable --now` runs BEFORE the manifest is removed: `enable --now`
    // failing on the start half still leaves the enablement symlinks in
    // place, and removing the unit file first would leave them dangling.
    // The rollback daemon-reload runs last, so systemd forgets the removed
    // unit rather than holding a loaded orphan.
    expect(calls.map(verbOf)).toEqual([
      "show-environment",
      "daemon-reload",
      "enable",
      "disable",
      "daemon-reload",
    ]);
  });

  it("on success runs preflight → reload → enable --now → linger and leaves the unit installed", async () => {
    const { calls, runner } = recordingRunner(() => false);

    await installWith(runner);

    expect(calls.map(verbOf)).toEqual([
      "show-environment",
      "daemon-reload",
      "enable",
      "loginctl:enable-linger",
    ]);
    const unit = await readFile(unitFile(), "utf8");
    expect(unit).toContain(`SyslogIdentifier=${label.id}`);
  });

  it("uninstall clears a failed unit entry after removing the file", async () => {
    const { calls, runner } = recordingRunner(() => false);

    await createLinuxController(runner).uninstall({ label });

    expect(calls.map(verbOf)).toEqual([
      "disable",
      "daemon-reload",
      "reset-failed",
    ]);
  });
});
