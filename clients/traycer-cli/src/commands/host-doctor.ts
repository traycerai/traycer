import {
  hostDoctorResponseSchema,
  type HostDoctorIssue,
} from "@traycer/protocol/host/maintenance";
import { config } from "../config";
import {
  DOCTOR_ISSUE_CODES,
  runDoctor,
  type DoctorIssue,
  type DoctorResult,
} from "../doctor";
import { lifecycleSnapshotRows } from "../host/lifecycle-snapshot";
import { readHostPidMetadata } from "../host/pid-metadata";
import {
  callHostRpcWithDispatch,
  parseCanonicalHostResponse,
  PLAIN_DISPATCH,
} from "../internal/host-rpc";
import { createCliLogger, errorFromUnknown } from "../logger";
import type { CommandFn, CommandResult } from "../runner/runner";
import { withCliScopedFileLock } from "../store/cli-lock";
import { hostDoctorLeasePath } from "../store/paths";

/**
 * The report this command emits: `DoctorResult`'s shape, with an issue code
 * widened to the wire's open string, because a running host reports codes
 * this CLI's catalogue does not name (`HOST_CREDENTIAL_SAVE_FAILED`).
 */
interface HostDoctorReport {
  readonly issues: readonly HostDoctorIssue[];
  readonly lifecycle: DoctorResult["lifecycle"];
}

/**
 * How long to wait for the host's answer. The host answers `host.doctor` by
 * running this whole command as its child, which on a healthy host can
 * outlast the transport's 15s default (two sequential 10s `systemctl` probes
 * on Linux alone), and caps that child at 60s before answering `cli-failed`.
 * Just above the host's cap, so a host that answers is always heard.
 */
const HOST_DOCTOR_RESPONSE_BUDGET_MS = 65_000;

/** Printed above a report the running host did not supply. */
const LOCAL_ONLY_NOTICE =
  "Checked on this machine only; problems only the running host can see may be missing.";

// `traycer host doctor [--json]` - asks the RUNNING host for its verdict
// over `host.doctor` and reports that, and runs the local engine alongside it
// for the lifecycle facts and as the fallback. The host's list is the
// authority on issues: it runs this same engine and then substitutes what
// only it knows - the credential it holds in memory, a credential it could not
// save, the paths a non-canonical `--host-data-dir` moved. One check stays
// local: see `withThisProcessPathIssue`.
//
// Any failure to get that list - no host running, not signed in, a refused or
// unreachable host, a host too old for the method, a host whose own run of
// this command failed, another run already asking - reports the local
// verdict with one line saying so.
// A diagnostic must never fail because the host is broken.
//
// Exit code is 0 on info-only / warning-only reports and non-zero when at
// least one issue's severity is `error` or `fatal`, so scripts can branch on
// success without parsing details.
export const hostDoctorCommand: CommandFn = async (
  ctx,
): Promise<CommandResult> => {
  const [local, hostIssues] = await Promise.all([
    runDoctor({
      environment: ctx.runtime.environment,
      portConflictDeps: null,
    }),
    readRunningHostIssues(),
  ]);
  const report: HostDoctorReport = {
    issues:
      hostIssues === null
        ? local.issues
        : withThisProcessPathIssue(hostIssues, local.issues),
    lifecycle: local.lifecycle,
  };
  const exitCode = report.issues.some(
    (i) => i.severity === "error" || i.severity === "fatal",
  )
    ? 1
    : 0;
  return {
    data: report,
    human: renderHumanReport(report, hostIssues === null),
    exitCode,
  };
};

/**
 * The host's list, with the PATH check swapped for this run's own. That check
 * answers for the PATH of the process that ran it, and the host's child read
 * the host's, which is not the one this report's reader resolves `traycer` on.
 */
function withThisProcessPathIssue(
  hostIssues: readonly HostDoctorIssue[],
  localIssues: readonly DoctorIssue[],
): readonly HostDoctorIssue[] {
  const isPathIssue = (issue: HostDoctorIssue): boolean =>
    issue.code === DOCTOR_ISSUE_CODES.CLI_SHADOWED_ON_PATH;
  return [
    ...hostIssues.filter((issue) => !isPathIssue(issue)),
    ...localIssues.filter(isPathIssue),
  ];
}

/**
 * The running host's issue list, or null when there is none to have.
 *
 * The host implements `host.doctor` by spawning `traycer host doctor --json`
 * as its own direct child, so a run whose parent is the host published in
 * pid.json IS that spawn and must not dial back, or each run would ask the
 * host to spawn another. No released host marks that child any other way: it
 * passes no environment of its own, and the CLI it spawns (the slot binary,
 * or an interpreter and its script) never re-launches itself, so its parent is
 * the host on every platform. The check runs before any sign-in or endpoint
 * work. A shell the host runs a command through can `exec` it and so pass the
 * same check; that run reports the local verdict, as this command did before
 * it asked the host.
 *
 * The lease is the second, independent limit, for a spawn the parent check
 * misses (a shell that does not `exec`, a launcher, any future intermediary).
 * It is held only around the call, and taken without waiting: the host's
 * spawn is this slot's CLI, so it finds the lease held by the run that asked
 * and reports locally, which ends the chain at one extra hop whatever sits
 * between host and CLI. A lease left by a run that died is taken over. The
 * cost is that of two runs whose calls overlap - each call can hold the lease
 * for the whole response budget - the second reports locally.
 */
async function readRunningHostIssues(): Promise<
  readonly HostDoctorIssue[] | null
> {
  const metadata = await readHostPidMetadata(config.environment);
  if (metadata !== null && metadata.pid === process.ppid) return null;
  try {
    const leased = await withCliScopedFileLock(
      {
        lockPath: hostDoctorLeasePath(config.environment),
        reason: "host-doctor",
        waitMs: 0,
        pollIntervalMs: 0,
      },
      () =>
        // Fail fast: one attempt, so a wedged host costs one response budget
        // before the local verdict.
        callHostRpcWithDispatch(
          "host.doctor",
          {},
          {
            ...PLAIN_DISPATCH,
            responseTimeoutMs: HOST_DOCTOR_RESPONSE_BUDGET_MS,
            failFast: true,
          },
        ),
    );
    if (leased.kind === "busy") return null;
    const response = parseCanonicalHostResponse(
      "host.doctor",
      hostDoctorResponseSchema,
      leased.result,
    );
    // `triviallyGreenIssueCodes` is a vantage hint for a remote viewer; this
    // command reads the host it shares a machine with and prints every issue.
    return response.status === "ok" ? response.issues : null;
  } catch (err) {
    createCliLogger(config.environment).info(
      "Host doctor fell back to the local verdict",
      {
        environment: config.environment,
        errorName: errorFromUnknown(err).name,
      },
    );
    return null;
  }
}

function renderHumanReport(
  report: HostDoctorReport,
  localOnly: boolean,
): string {
  const { issues } = report;
  const lines: string[] = localOnly ? [LOCAL_ONLY_NOTICE] : [];
  if (issues.length === 0) {
    lines.push("Doctor: no issues detected.");
  } else {
    lines.push(
      `Doctor found ${issues.length} issue${issues.length === 1 ? "" : "s"}.`,
      "",
    );
  }
  for (const issue of issues) {
    lines.push(`[${issue.severity.toUpperCase()}] ${issue.title}`);
    lines.push(`  code: ${issue.code}`);
    lines.push(`  ${issue.message}`);
    if (issue.terminalCommand !== null) {
      lines.push(`  fix:  ${issue.terminalCommand}`);
    }
    lines.push("");
  }
  // Facts, not findings: the lifecycle mode and who owns the run are what
  // explain a host that is (or is not) running after a reboot, healthy or not.
  const rows = lifecycleSnapshotRows(report.lifecycle);
  const width = rows.reduce((w, [label]) => Math.max(w, label.length), 0);
  // Each issue above already ends with a blank line.
  if (issues.length === 0) lines.push("");
  lines.push("Lifecycle:");
  for (const [label, value] of rows) {
    lines.push(`  ${label.padEnd(width)}  ${value}`);
  }
  return lines.join("\n").trimEnd();
}
