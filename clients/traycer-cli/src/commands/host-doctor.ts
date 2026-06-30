import { runDoctor, type DoctorIssue } from "../doctor";
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
    human: renderHumanReport(result.issues),
    exitCode,
  };
};

function renderHumanReport(issues: readonly DoctorIssue[]): string {
  if (issues.length === 0) {
    return "Doctor: no issues detected.";
  }
  const lines: string[] = [
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
  return lines.join("\n").trimEnd();
}
