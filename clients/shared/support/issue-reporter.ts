// Source of truth: `VITE_TRAYCER_OSS_REPO` baked at build time. Keep the
// fallback empty so a missing build var fails loudly (broken link) instead of
// silently routing user reports at a placeholder repo.
const TRAYCER_OSS_REPO: string = import.meta.env.VITE_TRAYCER_OSS_REPO ?? "";

export interface IssueReportInfo {
  readonly appVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly electronVersion: string | null;
  readonly nodeVersion: string | null;
  readonly chromeVersion: string | null;
  readonly hostVersion: string | null;
  readonly hostStatus: string | null;
  readonly hostPid: number | null;
  readonly title: string;
  readonly whatHappened: string;
  readonly stepsToReproduce: string;
  readonly expectedBehavior: string;
  readonly actualBehavior: string;
  readonly reportId: string | null;
}

export function buildGitHubIssueUrl(info: IssueReportInfo): string {
  const params = new URLSearchParams({
    title: info.title,
    body: buildIssueBody(info),
  });
  return `${TRAYCER_OSS_REPO}/issues/new?${params.toString()}`;
}

export function buildIssueBody(info: IssueReportInfo): string {
  const runtimeLines = [
    info.electronVersion !== null
      ? `| Electron | ${info.electronVersion} |`
      : null,
    info.chromeVersion !== null ? `| Chrome   | ${info.chromeVersion} |` : null,
    info.nodeVersion !== null ? `| Node.js  | ${info.nodeVersion} |` : null,
  ]
    .filter((line) => line !== null)
    .join("\n");

  const hostLine =
    info.hostVersion !== null
      ? `| Host | ${info.hostVersion} (${info.hostStatus ?? "unknown"}${info.hostPid !== null ? `, pid ${info.hostPid}` : ""}) |`
      : null;

  const reportIdLine =
    info.reportId !== null ? `| Support Report | \`${info.reportId}\` |\n` : "";

  return `\
### Environment

| Field | Value |
|---|---|
| App Version | ${info.appVersion} |
| Platform | ${info.platform} (${info.arch}) |
${hostLine !== null ? `${hostLine}\n` : ""}${runtimeLines ? `${runtimeLines}\n` : ""}${reportIdLine}
### What happened?

${info.whatHappened || "<!-- A clear description of the bug. Include any error messages you saw. -->"}

### Steps to reproduce

${info.stepsToReproduce || "1.\n2.\n3."}

### Expected behavior

${info.expectedBehavior || "<!-- What did you expect to happen? -->"}

### Actual behavior

${info.actualBehavior || "<!-- What actually happened instead? -->"}

### Additional context

<!-- Screenshots, screen recordings, or anything else that might help. -->`;
}
