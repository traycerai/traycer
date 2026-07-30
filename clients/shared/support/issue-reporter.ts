// Source of truth: `VITE_TRAYCER_OSS_REPO` baked at build time. Keep the
// fallback empty so a missing build var fails loudly (broken link) instead of
// silently routing user reports at a placeholder repo.
const TRAYCER_OSS_REPO: string = import.meta.env.VITE_TRAYCER_OSS_REPO ?? "";

// `.github/ISSUE_TEMPLATE/bug_report.yml` is a GitHub issue *form*: it
// prefills per field id and ignores a `body=` param entirely. `labels=` is
// deliberately never set here so the template's own `bug`/`triage` labels
// apply - an override would silently drop `triage`.
const BUG_REPORT_TEMPLATE = "bug_report.yml";

/**
 * Per-field values for the GitHub issue form, matching the form's field ids
 * verbatim (ticket 01's mapping). Produced ONLY by Electron main's
 * `support:buildPublicDraft` (ticket 09 / T6) - this module never composes
 * or scrubs public text itself, it only assembles a URL from what it is
 * handed.
 */
export interface PublicIssueDraftFields {
  readonly "what-happened": string;
  readonly version: string;
  readonly os: string;
  readonly component: string;
  readonly repro: string;
}

export interface PublicIssueDraft {
  readonly title: string;
  readonly fields: PublicIssueDraftFields;
}

/**
 * Assembles the GitHub issue form URL from an already-built, already-scrubbed
 * public draft. Contains zero composition or truncation logic: the 8 KiB URL
 * budget and every text transform live in `support-public-draft.ts` (Electron
 * main), behind the scrub boundary - the renderer must never be able to
 * produce public text of its own (ticket 09's guardrail against a renderer
 * fallback composition path).
 */
export function buildGitHubIssueUrl(draft: PublicIssueDraft): string {
  const params = new URLSearchParams({
    template: BUG_REPORT_TEMPLATE,
    title: draft.title,
    "what-happened": draft.fields["what-happened"],
    version: draft.fields.version,
    os: draft.fields.os,
    component: draft.fields.component,
    repro: draft.fields.repro,
  });
  return `${TRAYCER_OSS_REPO}/issues/new?${params.toString()}`;
}
