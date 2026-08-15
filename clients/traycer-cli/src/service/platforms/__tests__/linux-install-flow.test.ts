import { mkdtempSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createLinuxController, type ProcessRunner } from "../linux";
import { serviceManifestPath, type ServiceLabel } from "../../label";
import { ProcessRunError, type RunResult } from "../../process-runner";
import { CLI_ERROR_CODES } from "../../../runner/errors";
import { fileExists } from "../../install-binary";

// `stop --force`'s confirmed-settle branches finish with the SAME
// child-kill engine the macOS force paths use (`forceStopHostProcess`) -
// the local purge helper is gone, along with its own pid.json read/verdict
// gating. Stub the engine exactly the way `macos.test.ts` already stubs
// this identical seam (a WHOLE-MODULE factory - `linux.ts` imports only
// `forceStopHostProcess` from this module, so that is the only export this
// suite needs to supply).
const MOCKS = vi.hoisted(() => ({
  forceStopHostProcess: vi.fn(),
}));
vi.mock("../desktop-agent-shutdown", () => ({
  forceStopHostProcess: MOCKS.forceStopHostProcess,
}));

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

  it("replaces an existing unit with the OOM containment policy before reloading systemd", async () => {
    await writeFile(
      unitFile(),
      "[Unit]\nDescription=stale-unit-fixture\n",
      "utf8",
    );
    const calls: RecordedCall[] = [];
    const unitsSeenAtReload: string[] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      if (command === "systemctl" && args[1] === "daemon-reload") {
        unitsSeenAtReload.push(await readFile(unitFile(), "utf8"));
      }
      return ok();
    };

    await installWith(runner);

    expect(calls.map(verbOf)).toEqual([
      "show-environment",
      "daemon-reload",
      "enable",
      "loginctl:enable-linger",
    ]);
    expect(unitsSeenAtReload).toHaveLength(1);
    expect(unitsSeenAtReload[0]).not.toContain("stale-unit-fixture");
    expect(unitsSeenAtReload[0]).toContain("\nOOMPolicy=continue\n");
    const unit = await readFile(unitFile(), "utf8");
    expect(unit).not.toContain("stale-unit-fixture");
    expect(unit).toContain("\nOOMPolicy=continue\n");
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

// `stop --force`: a plain `systemctl stop` cannot promise the host is DOWN
// when it returns (the runner caps the subprocess at 15s; the unit inherits
// systemd's 90s default TimeoutStopSec), so force confirms through the
// unit's OWN state - `systemctl is-active`, never a pid - and escalates to
// `systemctl kill --signal=SIGKILL` when the plain stop does not settle it
// in time. Graces mirror the macOS/desktop-agent force-stop margins
// (~32s SIGTERM, 10s SIGKILL), so these poll through fake timers exactly
// the way `macos.test.ts` / `desktop-agent-shutdown.test.ts` already do for
// the identical wait shape.
describe("linux service stop --force", () => {
  beforeEach(() => {
    MOCKS.forceStopHostProcess.mockReset();
    // Default outcome: no-metadata, which is SUCCESS on this finisher (the
    // unit teardown already ran with positive confirmation, and an absent
    // record is the normal trace of a host that exited gracefully and
    // unlinked its own file - unlike the macOS ENTRY paths, where
    // no-metadata is a failure). Every pre-existing force-success test below
    // keeps passing through the finisher unchanged without staging its own
    // outcome; tests targeting outcome mapping specifically override this.
    MOCKS.forceStopHostProcess.mockResolvedValue({ kind: "no-metadata" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles 'inactive' right after the plain stop, so SIGKILL is never sent - cancels any scheduled auto-restart, RE-CONFIRMS, then purges pid.json", async () => {
    const calls: RecordedCall[] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      if (command === "systemctl" && args[1] === "is-active") {
        return { stdout: "inactive", stderr: "", exitCode: 3 };
      }
      return ok();
    };

    await createLinuxController(runner).stop(label, { force: true });

    // The first is-active probe settles immediately - no poll wait, no
    // kill, ever. A settled state alone is not proof nothing is scheduled
    // (the unit can settle at `failed` from a CRASH mid-grace, with
    // Restart=on-failure still queuing a relaunch) - the trailing `stop`
    // cancels it, and a FRESH is-active re-confirms before the purge (the
    // cancel's own failures/timeouts are swallowed, so only a positive
    // re-read vouches).
    expect(calls.map(verbOf)).toEqual([
      "stop",
      "is-active",
      "stop",
      "is-active",
    ]);
    expect(calls[2]?.args).toEqual([
      "--user",
      "stop",
      "ai.traycer.host.dev.service",
    ]);
    // A CONFIRMED inactive unit hands off to the child-kill engine, which
    // finishes the stop (and its own instance-matched purge) on the
    // published host's behalf.
    expect(MOCKS.forceStopHostProcess).toHaveBeenCalledWith("dev", "stop");
  });

  it("stays 'active' through the full SIGTERM grace, escalates to SIGKILL, cancels any scheduled auto-restart BEFORE the second poll, then settles and succeeds", async () => {
    vi.useFakeTimers();
    const calls: RecordedCall[] = [];
    let killIssued = false;
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      if (command === "systemctl" && args[1] === "kill") {
        killIssued = true;
        return ok();
      }
      if (command === "systemctl" && args[1] === "is-active") {
        return killIssued
          ? { stdout: "inactive", stderr: "", exitCode: 3 }
          : { stdout: "active", stderr: "", exitCode: 0 };
      }
      return ok();
    };

    const pending = createLinuxController(runner).stop(label, {
      force: true,
    });
    // SHUTDOWN_FORCE_EXIT_MS (30s) + STOP_EXIT_GRACE_MARGIN_MS (2s), plus
    // slack for the final poll - the same margin the macOS/desktop-agent
    // force-stop SIGTERM grace uses for the identical wait shape.
    await vi.advanceTimersByTimeAsync(40_000);

    await expect(pending).resolves.toBeUndefined();
    expect(calls.map(verbOf)).toContain("kill");
    const killCall = calls.find(
      (call) => call.command === "systemctl" && call.args[1] === "kill",
    );
    expect(killCall?.args).toEqual([
      "--user",
      "kill",
      "--signal=SIGKILL",
      "ai.traycer.host.dev.service",
    ]);
    // Shape: [stop, is-active...(active, never settling), kill, stop,
    // is-active...(settles)] - the initial stop, the SIGTERM-grace poll
    // that never settles, the SIGKILL, a renewed `stop` issued BEFORE the
    // second poll (cancels a relaunch a crash-during-grace may have
    // scheduled), and the SIGKILL-grace poll that settles.
    const verbs = calls.map(verbOf);
    expect(verbs[0]).toBe("stop");
    const killIndex = verbs.indexOf("kill");
    expect(killIndex).toBeGreaterThan(0);
    // Everything before the kill is the initial stop plus SIGTERM-grace
    // is-active polling - never another stop, never settling.
    expect(
      verbs.slice(0, killIndex).every((v) => v === "stop" || v === "is-active"),
    ).toBe(true);
    expect(verbs.slice(1, killIndex).every((v) => v === "is-active")).toBe(
      true,
    );
    // The renewed stop is issued IMMEDIATELY after the kill, before the
    // second poll even starts.
    expect(verbs[killIndex + 1]).toBe("stop");
    expect(calls[killIndex + 1]?.args).toEqual([
      "--user",
      "stop",
      "ai.traycer.host.dev.service",
    ]);
    expect(verbs[killIndex + 2]).toBe("is-active");
    // Exactly two `stop` verbs total: the initial one and the post-kill
    // cancel - never a third.
    expect(verbs.filter((v) => v === "stop")).toHaveLength(2);
    // The finisher runs on the SIGKILL-confirmed path too - same as the
    // SIGTERM one.
    expect(MOCKS.forceStopHostProcess).toHaveBeenCalledWith("dev", "stop");
  });

  it("is still 'active' after the SIGKILL grace too - SERVICE_CONTROL_FAILED, never a false success", async () => {
    vi.useFakeTimers();
    const calls: RecordedCall[] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      if (command === "systemctl" && args[1] === "is-active") {
        return { stdout: "active", stderr: "", exitCode: 0 };
      }
      return ok();
    };

    // Attach the rejection matcher BEFORE advancing timers - the promise
    // settles mid-advance, and asserting after would risk an unhandled
    // rejection between settling and the `await` below (same discipline
    // `macos.test.ts`'s CLI-owned stop-timeout test uses).
    const stopping = createLinuxController(runner).stop(label, {
      force: true,
    });
    const assertion = expect(stopping).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: expect.stringContaining("still active after SIGKILL"),
    });
    // Both graces back to back: ~32s SIGTERM + 10s SIGKILL, plus slack.
    await vi.advanceTimersByTimeAsync(50_000);

    await assertion;
    // The post-kill cancel `stop` still fires on the still-active failure
    // path too - it runs unconditionally right after the kill, before the
    // (here, never-settling) second poll.
    const verbs = calls.map(verbOf);
    const killIndex = verbs.indexOf("kill");
    expect(killIndex).toBeGreaterThan(0);
    expect(verbs[killIndex + 1]).toBe("stop");
    // Never confirmed, so the throw happens BEFORE the finisher - the
    // child-kill engine is never even asked about the published host.
    expect(MOCKS.forceStopHostProcess).not.toHaveBeenCalled();
  });

  it("'activating' does NOT count as settled - it drives the SIGKILL escalation exactly like 'active' does", async () => {
    vi.useFakeTimers();
    const calls: RecordedCall[] = [];
    let killIssued = false;
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      if (command === "systemctl" && args[1] === "kill") {
        killIssued = true;
        return ok();
      }
      if (command === "systemctl" && args[1] === "is-active") {
        // A concurrent restart bringing the unit back UP must never read as
        // a successful stop.
        return killIssued
          ? { stdout: "inactive", stderr: "", exitCode: 3 }
          : { stdout: "activating", stderr: "", exitCode: 3 };
      }
      return ok();
    };

    const pending = createLinuxController(runner).stop(label, {
      force: true,
    });
    await vi.advanceTimersByTimeAsync(40_000);

    await expect(pending).resolves.toBeUndefined();
    const verbs = calls.map(verbOf);
    expect(verbs).toContain("kill");
    // The renewed stop still fires right after the kill even though the
    // pre-kill state was 'activating' rather than 'active'.
    const killIndex = verbs.indexOf("kill");
    expect(verbs[killIndex + 1]).toBe("stop");
    expect(MOCKS.forceStopHostProcess).toHaveBeenCalledWith("dev", "stop");
  });

  it("a probe that throws (systemd unreachable) reads as NOT settled, not as a false success", async () => {
    vi.useFakeTimers();
    const calls: RecordedCall[] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      if (command === "systemctl" && args[1] === "is-active") {
        return Promise.reject(busError(command, args));
      }
      return ok();
    };

    const stopping = createLinuxController(runner).stop(label, {
      force: true,
    });
    const assertion = expect(stopping).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
    });
    await vi.advanceTimersByTimeAsync(50_000);

    await assertion;
    // The post-kill cancel `stop` is unaffected by the probe always
    // throwing - it is a different command, and cancelScheduledAutoRestart
    // has its own try/catch regardless.
    const verbs = calls.map(verbOf);
    const killIndex = verbs.indexOf("kill");
    expect(killIndex).toBeGreaterThan(0);
    expect(verbs[killIndex + 1]).toBe("stop");
    expect(MOCKS.forceStopHostProcess).not.toHaveBeenCalled();
  });

  // Codex's exact scenario: `tolerateNonZeroExit: true` means a probe that
  // could not reach the systemd user manager RESOLVES (never throws) with
  // an empty stdout and a nonzero exit - the OLD exclusion-list logic
  // (`state !== "active" && state !== "activating" && ...`) treated that
  // empty string as settled, reporting a stop it never confirmed. The
  // positive-list rewrite closes it: nothing but a recognized settled
  // state counts.
  it("empty stdout with a nonzero, tolerated exit (bus unreachable) reads as NOT settled - escalates, still empty - SERVICE_CONTROL_FAILED", async () => {
    vi.useFakeTimers();
    const calls: RecordedCall[] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      if (command === "systemctl" && args[1] === "is-active") {
        return {
          stdout: "",
          stderr: "Failed to connect to bus: No medium found",
          exitCode: 1,
        };
      }
      return ok();
    };

    const stopping = createLinuxController(runner).stop(label, {
      force: true,
    });
    const assertion = expect(stopping).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: expect.stringContaining("still active after SIGKILL"),
    });
    await vi.advanceTimersByTimeAsync(50_000);

    await assertion;
    const verbs = calls.map(verbOf);
    const killIndex = verbs.indexOf("kill");
    expect(killIndex).toBeGreaterThan(0);
    expect(verbs[killIndex + 1]).toBe("stop");
    expect(MOCKS.forceStopHostProcess).not.toHaveBeenCalled();
  });

  it("'failed' counts as a settled state - stop resolves without ever escalating to SIGKILL, and still cancels+RE-CONFIRMS any scheduled auto-restart before purging", async () => {
    // 'failed' is exactly the state a CRASH mid-grace settles at (as
    // opposed to a clean exit from our stop request) - Restart=on-failure
    // may have a relaunch scheduled, which is precisely why the cancel runs
    // even on this "already settled" path, and why a fresh re-confirm runs
    // after it rather than trusting the cancel itself.
    const calls: RecordedCall[] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      if (command === "systemctl" && args[1] === "is-active") {
        return { stdout: "failed", stderr: "", exitCode: 3 };
      }
      return ok();
    };

    await createLinuxController(runner).stop(label, { force: true });

    expect(calls.map(verbOf)).toEqual([
      "stop",
      "is-active",
      "stop",
      "is-active",
    ]);
    expect(MOCKS.forceStopHostProcess).toHaveBeenCalledWith("dev", "stop");
  });

  it("'unknown' counts as a settled state - stop resolves without ever escalating to SIGKILL, and still cancels+RE-CONFIRMS any scheduled auto-restart before purging", async () => {
    // Older systemctl's answer for a unit that is not loaded at all.
    const calls: RecordedCall[] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      if (command === "systemctl" && args[1] === "is-active") {
        return { stdout: "unknown", stderr: "", exitCode: 3 };
      }
      return ok();
    };

    await createLinuxController(runner).stop(label, { force: true });

    expect(calls.map(verbOf)).toEqual([
      "stop",
      "is-active",
      "stop",
      "is-active",
    ]);
    expect(MOCKS.forceStopHostProcess).toHaveBeenCalledWith("dev", "stop");
  });

  it("without --force, a stop never probes is-active or escalates to kill - today's semantics, pinned", async () => {
    const { calls, runner } = recordingRunner(() => false);

    await createLinuxController(runner).stop(label, { force: false });

    expect(calls.map(verbOf)).toEqual(["stop"]);
    // Non-force never confirms the stop, so the finisher is never reached
    // either.
    expect(MOCKS.forceStopHostProcess).not.toHaveBeenCalled();
  });

  // Branch-1 re-confirmation: the FIRST settle (right after the plain stop)
  // can itself be a crash - `failed` - whose Restart=on-failure replacement
  // is already coming back up by the time the cancel runs. The cancel's own
  // failures/timeouts are swallowed, so it proves nothing; only a FRESH
  // positive re-read after it does. An unconfirmed re-read falls through to
  // the ordinary SIGKILL escalation rather than reporting a stop that was
  // never actually proven.
  describe("post-cancel re-confirmation (branch-1 settle can be a crash whose replacement is already restarting)", () => {
    it("first settle is 'failed' (a crash), the post-cancel re-confirm sees 'activating' (the replacement) through the whole confirm grace, falls through to SIGKILL, which then settles for a successful stop", async () => {
      vi.useFakeTimers();
      const calls: RecordedCall[] = [];
      let stopCount = 0;
      let killIssued = false;
      const runner: ProcessRunner = async (command, args) => {
        calls.push({ command, args });
        if (command === "systemctl" && args[1] === "stop") {
          stopCount += 1;
          return ok();
        }
        if (command === "systemctl" && args[1] === "kill") {
          killIssued = true;
          return ok();
        }
        if (command === "systemctl" && args[1] === "is-active") {
          if (killIssued)
            return { stdout: "inactive", stderr: "", exitCode: 3 };
          // Before the cancel (stopCount is still 1, from the initial plain
          // stop only): settle immediately at 'failed' - the crash. After
          // the cancel (stopCount is 2): the replacement is coming back up.
          return stopCount >= 2
            ? { stdout: "activating", stderr: "", exitCode: 3 }
            : { stdout: "failed", stderr: "", exitCode: 3 };
        }
        return ok();
      };

      const pending = createLinuxController(runner).stop(label, {
        force: true,
      });
      // The SIGTERM-grace settle and the post-kill SIGKILL-grace settle are
      // both immediate (first poll) - only the 10s confirm grace needs
      // advancing, plus slack.
      await vi.advanceTimersByTimeAsync(15_000);

      await expect(pending).resolves.toBeUndefined();
      const verbs = calls.map(verbOf);
      // stop, is-active(failed, settled on the first probe), stop(cancel),
      // is-active...(activating, never settles through the confirm grace),
      // kill, stop(cancel again), is-active(inactive, settles).
      expect(verbs[0]).toBe("stop");
      expect(verbs[1]).toBe("is-active");
      expect(verbs[2]).toBe("stop");
      const killIndex = verbs.indexOf("kill");
      expect(killIndex).toBeGreaterThan(2);
      expect(verbs.slice(3, killIndex).every((v) => v === "is-active")).toBe(
        true,
      );
      expect(verbs.slice(3, killIndex).length).toBeGreaterThan(0);
      expect(verbs[killIndex + 1]).toBe("stop");
      expect(verbs[killIndex + 2]).toBe("is-active");
      expect(MOCKS.forceStopHostProcess).toHaveBeenCalledWith("dev", "stop");
    });

    it("if nothing ever settles after the kill either, SERVICE_CONTROL_FAILED - never a false success, and the finisher is never reached", async () => {
      vi.useFakeTimers();
      let stopCount = 0;
      const runner: ProcessRunner = async (command, args) => {
        if (command === "systemctl" && args[1] === "stop") {
          stopCount += 1;
          return ok();
        }
        if (command === "systemctl" && args[1] === "is-active") {
          // Settles once, right at the very first probe (the crash) - then
          // never again, through both the post-cancel re-confirm AND the
          // post-kill SIGKILL grace.
          return stopCount === 1
            ? { stdout: "failed", stderr: "", exitCode: 3 }
            : { stdout: "activating", stderr: "", exitCode: 3 };
        }
        return ok();
      };

      const stopping = createLinuxController(runner).stop(label, {
        force: true,
      });
      const assertion = expect(stopping).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: expect.stringContaining("still active after SIGKILL"),
      });
      // Confirm grace (10s) + SIGKILL grace (10s), plus slack.
      await vi.advanceTimersByTimeAsync(30_000);

      await assertion;
      // The unit never settled, so the throw happens BEFORE the finisher -
      // the child-kill engine is never even asked about the published host.
      expect(MOCKS.forceStopHostProcess).not.toHaveBeenCalled();
    });
  });

  // Outcome mapping: once the unit is CONFIRMED down,
  // `finishForcedStopForPublishedHost` hands off to the SAME child-kill
  // engine the macOS force paths use (`forceStopHostProcess`, mocked here
  // exactly the way `macos.test.ts` mocks it). A confirmed-down unit is
  // only HALF of what `--force` promises - a live host running OUTSIDE the
  // unit (started manually, or orphaned by a corrupted teardown) still gets
  // SIGTERM->SIGKILLed by the engine, and the engine's own instance-matched
  // purge replaces the local gate entirely.
  describe("forced-stop finisher: outcome mapping through forceStopHostProcess", () => {
    function settledRunner(): ProcessRunner {
      return async (command, args) => {
        if (command === "systemctl" && args[1] === "is-active") {
          return { stdout: "inactive", stderr: "", exitCode: 3 };
        }
        return ok();
      };
    }

    it("resolves when forceStopHostProcess reports 'stopped' - an orphan host running outside the unit got SIGTERM/SIGKILLed", async () => {
      MOCKS.forceStopHostProcess.mockResolvedValue({ kind: "stopped" });

      await expect(
        createLinuxController(settledRunner()).stop(label, { force: true }),
      ).resolves.toBeUndefined();

      expect(MOCKS.forceStopHostProcess).toHaveBeenCalledWith("dev", "stop");
    });

    it("resolves when forceStopHostProcess reports 'no-host' (the published pid was already gone)", async () => {
      MOCKS.forceStopHostProcess.mockResolvedValue({ kind: "no-host" });

      await expect(
        createLinuxController(settledRunner()).stop(label, { force: true }),
      ).resolves.toBeUndefined();
    });

    it("throws SERVICE_CONTROL_FAILED naming the identity refusal when forceStopHostProcess reports identity-unverified", async () => {
      MOCKS.forceStopHostProcess.mockResolvedValue({
        kind: "identity-unverified",
        pid: 4242,
      });

      await expect(
        createLinuxController(settledRunner()).stop(label, { force: true }),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: expect.stringContaining("cannot be verified"),
      });
      await expect(
        createLinuxController(settledRunner()).stop(label, { force: true }),
      ).rejects.toMatchObject({
        message: expect.stringContaining("host stop --force"),
      });
    });

    it("throws SERVICE_CONTROL_FAILED naming the survived-SIGKILL pid when forceStopHostProcess reports hung", async () => {
      MOCKS.forceStopHostProcess.mockResolvedValue({
        kind: "hung",
        pid: 4242,
      });

      await expect(
        createLinuxController(settledRunner()).stop(label, { force: true }),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: expect.stringContaining("survived SIGKILL"),
      });
    });

    it("carries operation 'restart' through stopForRestart's force path, and a terminal outcome's message names 'host restart --force'", async () => {
      MOCKS.forceStopHostProcess.mockResolvedValue({
        kind: "hung",
        pid: 4242,
      });

      await expect(
        createLinuxController(settledRunner()).stopForRestart(label, {
          force: true,
        }),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: expect.stringContaining("host restart --force"),
      });
      expect(MOCKS.forceStopHostProcess).toHaveBeenCalledWith("dev", "restart");
    });
  });
});
