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
// The form's `repro` field stays required for organic filers. The old
// dialog's `stepsToReproduce` field fills it when the user typed something;
// only an empty draft falls back to this placeholder rather than leaving the
// user to hit a required-field stop on GitHub.
const REPRO_PLACEHOLDER = "Filed from the in-app reporter.";
const MAX_URL_LENGTH = 8 * 1024;
const TRUNCATION_MARKER = " (truncated, see support report)";

export interface IssueReportInfo {
  readonly appVersion: string;
  readonly platform: string;
  readonly arch: string;
  // Runtime/host detail has no home in the form's per-field prefill (only
  // title/what-happened/version/os/repro map, per ticket 01). These stay on
  // this shape only so existing callers keep compiling unchanged until
  // ticket 09's buildPublicDraft replaces this interface as the sole
  // producer of public text.
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

interface ComposedFields {
  readonly title: string;
  readonly whatHappened: string;
  readonly repro: string;
}

export function buildGitHubIssueUrl(info: IssueReportInfo): string {
  let fields: ComposedFields = {
    title: info.title,
    whatHappened: composeWhatHappened(info),
    repro: composeRepro(info),
  };
  let url = buildIssueFormUrl(info, fields);

  // Largest/most-likely-oversized field first: the narrative, then repro
  // (also user-typed and unbounded), then title (short in practice).
  for (const field of ["whatHappened", "repro", "title"] as const) {
    if (url.length <= MAX_URL_LENGTH) break;
    fields = shrinkField(info, fields, field);
    url = buildIssueFormUrl(info, fields);
  }
  return url;
}

// The user's own words for what happened, with non-empty expected/actual
// behavior folded in under clear labels rather than silently dropped - the
// old dialog still collects them even though the form has no field for them.
function composeWhatHappened(info: IssueReportInfo): string {
  return [
    info.whatHappened,
    info.expectedBehavior.trim() === ""
      ? ""
      : `Expected: ${info.expectedBehavior}`,
    info.actualBehavior.trim() === "" ? "" : `Actual: ${info.actualBehavior}`,
  ]
    .filter((section) => section.trim() !== "")
    .join("\n\n");
}

function composeRepro(info: IssueReportInfo): string {
  return info.stepsToReproduce.trim() === ""
    ? REPRO_PLACEHOLDER
    : info.stepsToReproduce;
}

function shrinkField(
  info: IssueReportInfo,
  fields: ComposedFields,
  field: "whatHappened" | "repro" | "title",
): ComposedFields {
  const truncated = truncateToFit(fields[field], (candidate) =>
    buildIssueFormUrl(info, { ...fields, [field]: candidate }),
  );
  return { ...fields, [field]: truncated };
}

function buildIssueFormUrl(
  info: IssueReportInfo,
  fields: ComposedFields,
): string {
  const params = new URLSearchParams({
    template: BUG_REPORT_TEMPLATE,
    title: fields.title,
    "what-happened": fields.whatHappened,
    version: info.appVersion,
    os: `${info.platform} (${info.arch})`,
    component: COMPONENT_DESKTOP_APP,
    repro: fields.repro,
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
