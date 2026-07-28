import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  classifyLingerState,
  type ProbeCommandResult,
} from "@traycer-clients/shared/host-lifecycle";
import { DOCTOR_ISSUE_CODES, type DoctorIssue } from "./issues";

// The Linux half of doctor's run-state reading. The comment atop
// `service/platforms/linux.ts` promised "Doctor surfaces the missing linger
// as a warning" from the day linger became best-effort - but doctor had NO
// Linux probes at all, and `service status` deliberately keys liveness off
// pid metadata, never systemd. The result was a diagnostic dead end on the
// platform with the most failure modes: a restart-looping unit read as
// plain "stopped", a WSL box without systemd read as healthy-but-stopped,
// and a disabled linger (host dies at logout) was invisible everywhere.
//
// Same philosophy as the launchd wedge probe: read the manager's ACTUAL
// run state, report only on positive evidence, stay silent on healthy
// machines.

const execFileAsync = promisify(execFile);

/** Runs a probe command (`systemctl`/`loginctl`) and never rejects. */
export type SystemdProbeRunner = (
  command: string,
  args: readonly string[],
) => Promise<ProbeCommandResult>;

type ExecFileFailure = {
  readonly code: string | number | undefined;
  readonly stdout: string | undefined;
  readonly stderr: string | undefined;
  readonly killed: boolean | undefined;
  readonly signal: NodeJS.Signals | undefined;
};

export function createRealSystemdProbeRunner(): SystemdProbeRunner {
  return async (
    command: string,
    args: readonly string[],
  ): Promise<ProbeCommandResult> => {
    try {
      const { stdout, stderr } = await execFileAsync(command, [...args], {
        timeout: 10_000,
        encoding: "utf8",
      });
      return {
        exitCode: 0,
        stdout,
        stderr,
        timedOut: false,
        spawnFailed: false,
        signal: null,
      };
    } catch (error) {
      const failure = error as ExecFileFailure;
      if (typeof failure.code === "string") {
        return {
          exitCode: -1,
          stdout: "",
          stderr: "",
          timedOut: false,
          spawnFailed: true,
          signal: null,
        };
      }
      return {
        exitCode: typeof failure.code === "number" ? failure.code : -1,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
        timedOut: failure.killed === true,
        spawnFailed: false,
        signal: failure.signal ?? null,
      };
    }
  };
}

export interface LinuxSystemdProbeInput {
  readonly labelId: string;
  // Whether the unit file is on disk - the unit-state probe only runs for
  // an installed service; the reachability probe runs regardless, because
  // "no bus" is exactly why an install may have failed.
  readonly unitFileInstalled: boolean;
  readonly runner: SystemdProbeRunner;
}

/** Parse `systemctl show` `Key=Value` lines into a map. */
function parseShowProperties(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) out.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return out;
}

export async function probeLinuxSystemdHealth(
  input: LinuxSystemdProbeInput,
): Promise<DoctorIssue[]> {
  const issues: DoctorIssue[] = [];
  const unit = `${input.labelId}.service`;

  // ---- user-manager reachability ----
  // `systemctl --user` needs a per-user manager on a session bus. On WSL
  // without systemd, in `sudo su` shells, or SSH sessions with no logind
  // session, every lifecycle operation fails - and before this probe, in
  // exactly the environments where things fail, doctor had nothing to say
  // (install errors even steer users here).
  const reachability = await input.runner("systemctl", [
    "--user",
    "show-environment",
  ]);
  if (
    reachability.spawnFailed ||
    reachability.timedOut ||
    reachability.exitCode !== 0
  ) {
    // `spawnFailed` means `systemctl` itself could not be found/executed -
    // a genuinely non-systemd distro (Alpine/OpenRC, Void, ...), not a
    // systemd machine in an unreachable state. The WSL/headless-login
    // guidance below is worded entirely around the latter and would
    // misdirect a user on the former.
    const message = reachability.spawnFailed
      ? "systemctl could not be found or executed, so the host cannot be registered to start automatically. " +
        "This machine may not be running systemd (e.g. Alpine/OpenRC, Void) - Traycer's Linux service install requires a systemd user manager."
      : "systemctl --user cannot reach a user service manager, so the host cannot be registered to start automatically. " +
        "If this is WSL, enable systemd ('[boot]' / 'systemd=true' in /etc/wsl.conf, then 'wsl --shutdown' from Windows). " +
        "On a headless machine, log in through a systemd session or enable lingering.";
    issues.push({
      code: DOCTOR_ISSUE_CODES.SYSTEMD_USER_UNREACHABLE,
      severity: "error",
      title: "systemd user manager unreachable",
      message,
      fixAction: null,
      terminalCommand: "systemctl --user status",
      details: {
        stderr: reachability.stderr.trim(),
        exitCode: reachability.exitCode,
        spawnFailed: reachability.spawnFailed,
      },
    });
    // Without a reachable manager the remaining probes would only repeat
    // the same failure.
    return issues;
  }

  if (input.unitFileInstalled) {
    const show = await input.runner("systemctl", [
      "--user",
      "show",
      unit,
      "-p",
      "LoadState,ActiveState,SubState,Result,ConditionResult,ConditionTimestampMonotonic,NRestarts,ExecMainStatus,UnitFileState",
    ]);
    if (!show.spawnFailed && !show.timedOut && show.exitCode === 0) {
      const props = parseShowProperties(show.stdout);
      const loadState = props.get("LoadState") ?? "";
      const activeState = props.get("ActiveState") ?? "";
      const subState = props.get("SubState") ?? "";
      // Positive-evidence guard, verified against a live systemd 255:
      // `systemctl show` on a NOT-LOADED unit exits 0 and reports the
      // property DEFAULTS - which include `ConditionResult=no` - and a
      // loaded unit that has never attempted a start reports the same
      // default with ConditionTimestampMonotonic=0. Only a start that
      // actually evaluated the condition (non-zero timestamp, loaded
      // unit) may report "skipped because the CLI is missing".
      const conditionStamp = props.get("ConditionTimestampMonotonic") ?? "";
      const conditionEvaluated =
        loadState === "loaded" &&
        conditionStamp !== "" &&
        conditionStamp !== "0";
      const conditionResult = conditionEvaluated
        ? (props.get("ConditionResult") ?? "")
        : "";

      // A unit that landed `failed` (start-limit hit) or is cycling
      // `auto-restart` is the exact state `service status` reads as plain
      // "stopped" - liveness there deliberately keys off pid metadata.
      // This is where the truth surfaces.
      if (activeState === "failed" || subState === "auto-restart") {
        issues.push({
          code: DOCTOR_ISSUE_CODES.SERVICE_UNIT_FAILED,
          severity: "error",
          title: "Host service is failing to start",
          message: `The systemd unit '${unit}' is ${activeState === "failed" ? "in the failed state" : "restart-looping"} (result: ${props.get("Result") ?? "unknown"}, last exit: ${props.get("ExecMainStatus") ?? "unknown"}, restarts: ${props.get("NRestarts") ?? "unknown"}). The journal has the failing start's output.`,
          fixAction: null,
          terminalCommand: `journalctl --user -u ${unit} -n 50 --no-pager`,
          details: {
            unit,
            activeState,
            subState,
            result: props.get("Result") ?? null,
            execMainStatus: props.get("ExecMainStatus") ?? null,
            restarts: props.get("NRestarts") ?? null,
          },
        });
      }

      // ConditionFileIsExecutable gates the start on the CLI binary
      // existing; `no` here means systemd skipped the last start because
      // the binary the unit points at is gone - stranded definition.
      if (conditionResult === "no") {
        issues.push({
          code: DOCTOR_ISSUE_CODES.SERVICE_START_CONDITION_UNMET,
          severity: "error",
          title: "Host service skipped: CLI binary missing",
          message: `systemd skipped starting '${unit}' because the CLI binary the unit points at no longer exists or is not executable. Reinstalling the host repairs the service definition.`,
          fixAction: "host-install",
          terminalCommand: "traycer host install",
          details: { unit },
        });
      }
    }

    // ---- linger ----
    // Without linger the user manager - and the host with it - is torn
    // down at last logout and only returns at next login. Enabling it is
    // best-effort at install (polkit may refuse non-interactively); this
    // warning is the promised follow-up surface.
    const user = process.env.USER ?? process.env.USERNAME ?? "";
    const lingerResult = await input.runner("loginctl", [
      "show-user",
      user,
      "-p",
      "Linger",
    ]);
    const linger = classifyLingerState(lingerResult, user.length > 0);
    if (linger.kind === "observed" && !linger.enabled) {
      issues.push({
        code: DOCTOR_ISSUE_CODES.LINGER_DISABLED,
        severity: "warning",
        title: "Host stops at logout (lingering disabled)",
        message:
          "systemd lingering is disabled for this user, so the host is torn down at your last logout and background work stops until you log in again.",
        fixAction: null,
        terminalCommand: `loginctl enable-linger ${user}`,
        details: { user },
      });
    }
  }

  return issues;
}
