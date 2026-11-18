import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  classifyLaunchctlPrintResult,
  deriveWedgeVerdict,
  type ProbeCommandResult,
} from "@traycer-clients/shared/host-lifecycle";
import { DOCTOR_ISSUE_CODES, type DoctorIssue } from "./issues";

// The v1.1.8 field lockout, as a doctor probe: launchd reports the host's
// label as *loaded*, so every registration-keyed check reads "healthy",
// while the job itself is wedged (spawn failed / EX_CONFIG last exit /
// LWCR mismatch) and no host process ever starts. Registration presence is
// not health - this probe reads the job's actual run state from the same
// `launchctl print` bytes the ownership checks already parse, through the
// shared depth-enforced parser and the shared positive-evidence wedge
// predicate. Only positive wedge markers report; "loaded and quiet" stays
// silent so the probe can never become noise on a healthy machine.

const execFileAsync = promisify(execFile);

export type LaunchdPrintRunner = (
  serviceTarget: string,
) => Promise<ProbeCommandResult>;

// execFile's rejection shape: launchctl's non-zero exit carries a numeric
// `code` plus captured output; a spawn failure carries a string errno; a
// timeout kill carries `killed` + the signal. Every field may be absent.
type ExecFileFailure = {
  readonly code: string | number | undefined;
  readonly stdout: string | undefined;
  readonly stderr: string | undefined;
  readonly killed: boolean | undefined;
  readonly signal: NodeJS.Signals | undefined;
};

export function createRealLaunchdPrintRunner(): LaunchdPrintRunner {
  return async (serviceTarget: string): Promise<ProbeCommandResult> => {
    try {
      const { stdout, stderr } = await execFileAsync(
        "launchctl",
        ["print", serviceTarget],
        { timeout: 10_000, encoding: "utf8" },
      );
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

export interface MacosWedgeProbeInput {
  readonly labelId: string;
  readonly agentLabelId: string;
  readonly hasPidMetadata: boolean;
  readonly runner: LaunchdPrintRunner;
}

export async function probeMacosWedgedJob(
  input: MacosWedgeProbeInput,
): Promise<DoctorIssue | null> {
  if (typeof process.getuid !== "function") return null;
  const uid = process.getuid();
  // Agent label first - it is the live job on Desktop-managed machines.
  for (const labelId of [input.agentLabelId, input.labelId]) {
    const result = await input.runner(`gui/${uid}/${labelId}`);
    const probe = classifyLaunchctlPrintResult(result, null, labelId);
    if (probe.kind !== "observed") continue;
    const verdict = deriveWedgeVerdict(probe, {
      // Login-item enablement is not observable from the CLI; leaving it
      // null keeps the loaded-but-no-pid heuristic disarmed, so only the
      // positive markers (spawn failed / EX_CONFIG / LWCR) can report.
      loginItemEnabled: null,
      hasPidMetadata: input.hasPidMetadata,
      hasAttemptProgress: false,
    });
    // A loaded job answers the question for this machine either way; do
    // not fall through to the second label and report a stale sibling.
    if (verdict.kind !== "wedged") return null;

    const run = probe.runState;
    const evidence: string[] = [];
    if (run.jobState.kind === "observed") {
      evidence.push(`state = ${run.jobState.value}`);
    }
    if (run.lastExitCode.kind === "observed") {
      evidence.push(`last exit code = ${run.lastExitCode.value}`);
    }
    if (run.lastExitReason.kind === "observed") {
      evidence.push(`last exit reason = ${run.lastExitReason.value}`);
    }
    const summary = [verdict.reasons.join(", "), ...evidence].join("; ");
    const desktopOwned = probe.ownership.kind === "smappservice";
    return {
      code: DOCTOR_ISSUE_CODES.SERVICE_JOB_WEDGED,
      severity: "error",
      title: "Host launchd job is loaded but wedged",
      message: desktopOwned
        ? `launchd has '${labelId}' loaded but the job cannot run (${summary}). ` +
          "The host will not start until the job is re-registered. Relaunch the " +
          "Traycer Desktop app to repair it; if that does not help, run " +
          "'traycer host service uninstall' and then relaunch the app (or run " +
          "'traycer host service install' to switch to CLI management)."
        : `launchd has '${labelId}' loaded but the job cannot run (${summary}). ` +
          "Run 'traycer host service install' to re-register it. A restart " +
          "cannot fix this: it kickstarts the definition launchd already has " +
          "cached, and that definition is the one that will not spawn - only " +
          "a bootout/bootstrap cycle replaces it.",
      // `service-install` is the register cycle (bootout -> bootstrap ->
      // kickstart), which is what a wedged job needs. `host-start` and
      // `host-restart` both resolve to `restartHost()` in the GUI, i.e. the
      // kickstart that already failed - the button and the copyable command
      // would both return the user to this same card.
      fixAction: desktopOwned ? null : "service-install",
      terminalCommand: desktopOwned
        ? "traycer host service uninstall"
        : "traycer host service install",
      details: {
        labelId,
        ownership: probe.ownership.kind,
        reasons: verdict.reasons,
        jobState: run.jobState.kind === "observed" ? run.jobState.value : null,
        lastExitCode:
          run.lastExitCode.kind === "observed" ? run.lastExitCode.value : null,
        lastExitReason:
          run.lastExitReason.kind === "observed"
            ? run.lastExitReason.value
            : null,
      },
    };
  }
  return null;
}
