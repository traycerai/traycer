// Source of truth: `VITE_TRAYCER_OSS_REPO` baked at build time. Keep the
// fallback empty so a missing build var fails loudly (broken link) instead of
// silently routing user reports at a placeholder repo.
const TRAYCER_OSS_REPO: string = import.meta.env.VITE_TRAYCER_OSS_REPO ?? "";

/**
 * Per-field values for the GitHub issue form, matching each template's field
 * ids verbatim (ticket 01's bug mapping; ticket 07 adds idea/other routing).
 * Produced ONLY by Electron main's `support:buildPublicDraft` (ticket 09 / T6,
 * extended by ticket 07) - this module never composes or scrubs public text
 * itself, it only assembles a URL from what it is handed.
 */
export interface PublicIssueDraftBugFields {
  readonly "what-happened": string;
  readonly version: string;
  readonly os: string;
  readonly component: string;
  readonly repro: string;
}

export interface PublicIssueDraftFeatureRequestFields {
  readonly problem: string;
  readonly proposal: string;
  readonly alternatives: string;
  readonly component: string;
}

export interface PublicIssueDraftGeneralFields {
  readonly details: string;
}

export type PublicIssueDraft =
  | {
      readonly template: "bug_report.yml";
      readonly title: string;
      readonly fields: PublicIssueDraftBugFields;
    }
  | {
      readonly template: "feature_request.yml";
      readonly title: string;
      readonly fields: PublicIssueDraftFeatureRequestFields;
    }
  | {
      readonly template: "general.yml";
      readonly title: string;
      readonly fields: PublicIssueDraftGeneralFields;
    };

/**
 * Assembles the GitHub issue form URL from an already-built, already-scrubbed
 * public draft. Contains zero composition or truncation logic: the 8 KiB URL
 * budget and every text transform live in `support-public-draft.ts` (Electron
 * main), behind the scrub boundary - the renderer must never be able to
 * produce public text of its own (ticket 09's guardrail against a renderer
 * fallback composition path). `labels=` is deliberately never set for any
 * template so its own frozen labels (e.g. `bug`/`triage`) apply - an override
 * would silently drop `triage`.
 */
export function buildGitHubIssueUrl(draft: PublicIssueDraft): string {
  const params = new URLSearchParams(issueFormParams(draft));
  return `${TRAYCER_OSS_REPO}/issues/new?${params.toString()}`;
}

function issueFormParams(draft: PublicIssueDraft): Record<string, string> {
  return {
    template: draft.template,
    title: draft.title,
    ...draft.fields,
  };
}
