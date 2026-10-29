import { withLock } from "@traycer-clients/shared/host-lock/cross-process-lock";
import {
  hostDoctorResponseSchema,
  type HostDoctorIssue,
} from "@traycer/protocol/host/maintenance";
import { config } from "../config";
import { runDoctor, type DoctorResult } from "../doctor";
import { lifecycleSnapshotRows } from "../host/lifecycle-snapshot";
import { readHostPidMetadata } from "../host/pid-metadata";
import {
  callHostRpcWithDispatch,
  parseCanonicalHostResponse,
  PLAIN_DISPATCH,
} from "../internal/host-rpc";
import { createCliLogger, errorFromUnknown } from "../logger";
import type { CommandFn, CommandResult } from "../runner/runner";
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

/** Printed above a report the running host did not supply. */
const LOCAL_ONLY_NOTICE =
  "Checked on this machine only; problems only the running host can see may be missing.";

// `traycer host doctor [--json]` - asks the RUNNING host for its verdict
// over `host.doctor` and reports that, and runs the local engine alongside it
// for the lifecycle facts and as the fallback. The host's list is the
// authority on issues: it runs this same engine and then substitutes what
// only it knows - the credential it holds in memory, a credential it could not
// save, the paths a non-canonical `--host-data-dir` moved.
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
    issues: hostIssues ?? local.issues,
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
 * cost is that of two runs at the same moment, the second reports locally.
 */
async function readRunningHostIssues(): Promise<
  readonly HostDoctorIssue[] | null
> {
  const metadata = await readHostPidMetadata(config.environment);
  if (metadata !== null && metadata.pid === process.ppid) return null;
  try {
    const leased = await withLock(
      {
        lockPath: hostDoctorLeasePath(config.environment),
        reason: "host-doctor",
        waitMs: 0,
        pollIntervalMs: 0,
      },
      () =>
        // Fail fast: one attempt within the transport's dial and response
        // deadlines, so a wedged host costs one wait before the local verdict.
        callHostRpcWithDispatch(
          "host.doctor",
          {},
          { ...PLAIN_DISPATCH, failFast: true },
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
