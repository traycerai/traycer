// Source of truth: `VITE_TRAYCER_OSS_REPO` baked at build time. Keep the
// fallback empty so a missing build var fails loudly (broken link) instead of
// silently routing user reports at a placeholder repo.
const TRAYCER_OSS_REPO: string = import.meta.env.VITE_TRAYCER_OSS_REPO ?? "";

// `.github/ISSUE_TEMPLATE/bug_report.yml` is a GitHub issue *form*: it
// prefills per field id and ignores a `body=` param entirely. `labels=` is
// deliberately never set here so the template's own `bug`/`triage` labels
// apply - an override would silently drop `triage`.
const BUG_REPORT_TEMPLATE = "bug_report.yml";
const COMPONENT_DESKTOP_APP = "Desktop app";
// The form's `repro` field stays required for organic filers. App-routed
// drafts don't collect step-by-step repro, so it's prefilled with a standard
// sentence rather than left for the user to hit a required-field stop on.
const REPRO_PLACEHOLDER = "Filed from the in-app reporter.";
const MAX_URL_LENGTH = 8 * 1024;
const TRUNCATION_MARKER = " (truncated, see support report)";

export interface IssueReportInfo {
  readonly appVersion: string;
  readonly platform: string;
  readonly arch: string;
  // Runtime/host detail and the extra narrative fields below have no home in
  // the form's per-field prefill (only title/what-happened/version/os map,
  // per ticket 01). They stay on this shape only so existing callers keep
  // compiling unchanged until ticket 09's buildPublicDraft replaces this
  // interface as the sole producer of public text.
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

interface UrlFields {
  readonly title: string;
  readonly whatHappened: string;
}

export function buildGitHubIssueUrl(info: IssueReportInfo): string {
  const full = buildIssueFormUrl(info, info);
  if (full.length <= MAX_URL_LENGTH) return full;

  const whatHappened = truncateToFit(info.whatHappened, (candidate) =>
    buildIssueFormUrl(info, { title: info.title, whatHappened: candidate }),
  );
  const afterWhatHappened = buildIssueFormUrl(info, {
    title: info.title,
    whatHappened,
  });
  if (afterWhatHappened.length <= MAX_URL_LENGTH) return afterWhatHappened;

  const title = truncateToFit(info.title, (candidate) =>
    buildIssueFormUrl(info, { title: candidate, whatHappened }),
  );
  return buildIssueFormUrl(info, { title, whatHappened });
}

function buildIssueFormUrl(info: IssueReportInfo, fields: UrlFields): string {
  const params = new URLSearchParams({
    template: BUG_REPORT_TEMPLATE,
    title: fields.title,
    "what-happened": fields.whatHappened,
    version: info.appVersion,
    os: `${info.platform} (${info.arch})`,
    component: COMPONENT_DESKTOP_APP,
    repro: REPRO_PLACEHOLDER,
  });
  return `${TRAYCER_OSS_REPO}/issues/new?${params.toString()}`;
}

// Binary-searches the longest prefix of `value` whose truncated-plus-marker
// form keeps the URL produced by `urlFor` within the 8 KiB budget, measuring
// the actual percent-encoded URL each step rather than assuming an
// encoding-expansion ratio.
function truncateToFit(
  value: string,
  urlFor: (candidate: string) => string,
): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = `${value.slice(0, mid)}${TRUNCATION_MARKER}`;
    if (urlFor(candidate).length <= MAX_URL_LENGTH) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return `${value.slice(0, low)}${TRUNCATION_MARKER}`;
}
