import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProbeCommandResult } from "@traycer-clients/shared/host-lifecycle";
import { DOCTOR_ISSUE_CODES } from "../issues";
import {
  probeLinuxSystemdHealth,
  type SystemdProbeRunner,
} from "../systemd-health";

/**
 * The Linux doctor probes, fixture-driven. Until this module existed doctor
 * had ZERO Linux probes while `service/platforms/linux.ts` claimed "Doctor
 * surfaces the missing linger as a warning" - and `service status`
 * deliberately keys liveness off pid metadata, so a failed / restart-looping
 * unit read as plain "stopped" with nowhere that told the truth. Each row
 * here is one of those dead ends.
 */

const LABEL_ID = "ai.traycer.host";
const UNIT = `${LABEL_ID}.service`;

function ok(stdout: string): ProbeCommandResult {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    timedOut: false,
    spawnFailed: false,
    signal: null,
  };
}

function fail(stderr: string): ProbeCommandResult {
  return {
    exitCode: 1,
    stdout: "",
    stderr,
    timedOut: false,
    spawnFailed: false,
    signal: null,
  };
}

function spawnFailure(): ProbeCommandResult {
  return {
    exitCode: -1,
    stdout: "",
    stderr: "",
    timedOut: false,
    spawnFailed: true,
    signal: null,
  };
}

interface RecordedProbe {
  readonly command: string;
  readonly args: readonly string[];
}

function runnerWith(respond: (probe: RecordedProbe) => ProbeCommandResult): {
  readonly calls: RecordedProbe[];
  readonly runner: SystemdProbeRunner;
} {
  const calls: RecordedProbe[] = [];
  const runner: SystemdProbeRunner = (command, args) => {
    const call: RecordedProbe = { command, args };
    calls.push(call);
    return Promise.resolve(respond(call));
  };
  return { calls, runner };
}

function showOutput(props: Record<string, string>): string {
  return Object.entries(props)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

const HEALTHY_SHOW = {
  LoadState: "loaded",
  ActiveState: "active",
  SubState: "running",
  Result: "success",
  ConditionResult: "yes",
  ConditionTimestampMonotonic: "8412345",
  NRestarts: "0",
  ExecMainStatus: "0",
  UnitFileState: "enabled",
};

function respondHealthy(probe: RecordedProbe): ProbeCommandResult {
  if (probe.command === "loginctl") return ok("Linger=yes\n");
  if (probe.args[1] === "show-environment") return ok("PATH=/usr/bin\n");
  return ok(showOutput(HEALTHY_SHOW));
}

let savedUser: string | undefined;

beforeEach(() => {
  savedUser = process.env.USER;
  process.env.USER = "testuser";
});

afterEach(() => {
  if (savedUser === undefined) delete process.env.USER;
  else process.env.USER = savedUser;
});

describe("probeLinuxSystemdHealth", () => {
  it("stays silent on a healthy machine", async () => {
    const { runner } = runnerWith(respondHealthy);
    const issues = await probeLinuxSystemdHealth({
      labelId: LABEL_ID,
      unitFileInstalled: true,
      runner,
    });
    expect(issues).toEqual([]);
  });

  it("reports an unreachable user manager - and probes nothing further", async () => {
    // The WSL-without-systemd / sudo-su / headless-SSH state: the exact
    // environments where install fails and steers users to doctor.
    const { calls, runner } = runnerWith((probe) =>
      probe.args[1] === "show-environment"
        ? fail("Failed to connect to bus: No medium found")
        : ok(""),
    );
    const issues = await probeLinuxSystemdHealth({
      labelId: LABEL_ID,
      unitFileInstalled: true,
      runner,
    });
    expect(issues.map((issue) => issue.code)).toEqual([
      DOCTOR_ISSUE_CODES.SYSTEMD_USER_UNREACHABLE,
    ]);
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.message).toContain("WSL");
    // Follow-on probes would only repeat the same failure.
    expect(calls).toHaveLength(1);
  });

  it("names systemctl itself as missing on a genuinely non-systemd distro, not WSL/headless-login", async () => {
    // `spawnFailed` (ENOENT/EACCES launching `systemctl`) is a different
    // machine than a systemd box that cannot reach its user manager - e.g.
    // Alpine/OpenRC, Void. The WSL/headless-login guidance would misdirect
    // a user here, since neither applies.
    const { runner } = runnerWith((probe) =>
      probe.args[1] === "show-environment" ? spawnFailure() : ok(""),
    );
    const issues = await probeLinuxSystemdHealth({
      labelId: LABEL_ID,
      unitFileInstalled: true,
      runner,
    });
    expect(issues.map((issue) => issue.code)).toEqual([
      DOCTOR_ISSUE_CODES.SYSTEMD_USER_UNREACHABLE,
    ]);
    expect(issues[0]?.message).toContain("could not be found or executed");
    expect(issues[0]?.message).not.toContain("WSL");
  });

  it("reports a failed unit with the journal command to read", async () => {
    const { runner } = runnerWith((probe) => {
      if (probe.args[1] === "show")
        return ok(
          showOutput({
            ...HEALTHY_SHOW,
            ActiveState: "failed",
            SubState: "failed",
            Result: "exit-code",
            ExecMainStatus: "127",
            NRestarts: "5",
          }),
        );
      return respondHealthy(probe);
    });
    const issues = await probeLinuxSystemdHealth({
      labelId: LABEL_ID,
      unitFileInstalled: true,
      runner,
    });
    expect(issues.map((issue) => issue.code)).toEqual([
      DOCTOR_ISSUE_CODES.SERVICE_UNIT_FAILED,
    ]);
    expect(issues[0]?.terminalCommand).toContain(
      `journalctl --user -u ${UNIT}`,
    );
    expect(issues[0]?.details).toMatchObject({ execMainStatus: "127" });
  });

  it("reports a restart-looping unit (auto-restart), which status reads as merely stopped", async () => {
    const { runner } = runnerWith((probe) => {
      if (probe.args[1] === "show")
        return ok(
          showOutput({
            ...HEALTHY_SHOW,
            ActiveState: "activating",
            SubState: "auto-restart",
            Result: "exit-code",
          }),
        );
      return respondHealthy(probe);
    });
    const issues = await probeLinuxSystemdHealth({
      labelId: LABEL_ID,
      unitFileInstalled: true,
      runner,
    });
    expect(issues.map((issue) => issue.code)).toEqual([
      DOCTOR_ISSUE_CODES.SERVICE_UNIT_FAILED,
    ]);
  });

  it("reports a start skipped by the missing-CLI condition, pointing at reinstall", async () => {
    const { runner } = runnerWith((probe) => {
      if (probe.args[1] === "show")
        return ok(
          showOutput({
            ...HEALTHY_SHOW,
            ActiveState: "inactive",
            SubState: "dead",
            ConditionResult: "no",
          }),
        );
      return respondHealthy(probe);
    });
    const issues = await probeLinuxSystemdHealth({
      labelId: LABEL_ID,
      unitFileInstalled: true,
      runner,
    });
    expect(issues.map((issue) => issue.code)).toEqual([
      DOCTOR_ISSUE_CODES.SERVICE_START_CONDITION_UNMET,
    ]);
    expect(issues[0]?.fixAction).toBe("host-install");
  });

  it("stays silent on the not-loaded and never-started property DEFAULTS, which include ConditionResult=no", async () => {
    // Verified live on systemd 255: `systemctl show` of a NOT-LOADED unit
    // exits 0 reporting property defaults - ConditionResult=no among them -
    // and a loaded unit that never attempted a start reports the same
    // default with ConditionTimestampMonotonic=0. Without the
    // positive-evidence guard this probe would cry "CLI binary missing" on
    // every such machine.
    const { runner } = runnerWith((probe) => {
      if (probe.args[1] === "show")
        return ok(
          showOutput({
            ...HEALTHY_SHOW,
            ActiveState: "inactive",
            SubState: "dead",
            ConditionResult: "no",
            ConditionTimestampMonotonic: "0",
          }),
        );
      return respondHealthy(probe);
    });
    const issues = await probeLinuxSystemdHealth({
      labelId: LABEL_ID,
      unitFileInstalled: true,
      runner,
    });
    expect(issues).toEqual([]);
  });

  it("warns when lingering is disabled - the promised follow-up for best-effort enable-linger", async () => {
    const { runner } = runnerWith((probe) =>
      probe.command === "loginctl" ? ok("Linger=no\n") : respondHealthy(probe),
    );
    const issues = await probeLinuxSystemdHealth({
      labelId: LABEL_ID,
      unitFileInstalled: true,
      runner,
    });
    expect(issues.map((issue) => issue.code)).toEqual([
      DOCTOR_ISSUE_CODES.LINGER_DISABLED,
    ]);
    expect(issues[0]?.severity).toBe("warning");
    expect(issues[0]?.terminalCommand).toBe("loginctl enable-linger testuser");
  });

  it("skips unit and linger probes when no unit file is installed", async () => {
    const { calls, runner } = runnerWith(respondHealthy);
    const issues = await probeLinuxSystemdHealth({
      labelId: LABEL_ID,
      unitFileInstalled: false,
      runner,
    });
    expect(issues).toEqual([]);
    expect(calls.map((call) => call.args[1] ?? call.command)).toEqual([
      "show-environment",
    ]);
  });
});
