import { runDoctor, type DoctorResult } from "../doctor";
import { lifecycleSnapshotRows } from "../host/lifecycle-snapshot";
import type { CommandFn, CommandResult } from "../runner/runner";

// `traycer host doctor [--json]` - runs the doctor engine and emits a
// structured DoctorResult. Exit code is 0 on info-only / warning-only
// reports and non-zero when at least one issue's severity is `error`
// or `fatal` so scripts can branch on success without parsing details.
export const hostDoctorCommand: CommandFn = async (
  ctx,
): Promise<CommandResult> => {
  const result = await runDoctor({
    environment: ctx.runtime.environment,
    portConflictDeps: null,
  });
  const exitCode = result.issues.some(
    (i) => i.severity === "error" || i.severity === "fatal",
  )
    ? 1
    : 0;
  return {
    data: result,
    human: renderHumanReport(result),
    exitCode,
  };
};

function renderHumanReport(result: DoctorResult): string {
  const { issues } = result;
  const lines: string[] =
    issues.length === 0
      ? ["Doctor: no issues detected."]
      : [
          `Doctor found ${issues.length} issue${issues.length === 1 ? "" : "s"}.`,
          "",
        ];
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
  const rows = lifecycleSnapshotRows(result.lifecycle);
  const width = rows.reduce((w, [label]) => Math.max(w, label.length), 0);
  // Each issue above already ends with a blank line.
  if (issues.length === 0) lines.push("");
  lines.push("Lifecycle:");
  for (const [label, value] of rows) {
    lines.push(`  ${label.padEnd(width)}  ${value}`);
  }
  return lines.join("\n").trimEnd();
}
