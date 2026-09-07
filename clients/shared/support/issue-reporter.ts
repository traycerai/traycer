// Source of truth: `VITE_TRAYCER_OSS_REPO` baked at build time.
// Keep the fallback empty so a missing build var fails loudly (broken link) instead of silently routing user reports at a placeholder repo.
const TRAYCER_OSS_REPO: string = import.meta.env.VITE_TRAYCER_OSS_REPO ?? "";

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
     * Assembles the GitHub issue form URL from an already-built, already-scrubbed public draft.
     * `labels=` is deliberately never set for any template so its own frozen labels (e.g. `bug`/`triage`) apply - an override would silently drop `triage`.
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
