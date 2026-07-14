const MAX_REPORT_CONTEXT_LENGTH = 300;

export interface ReportIssueContext {
  readonly title: string;
  readonly message: string | null;
  readonly code: string | null;
  readonly source: string | null;
}

/**
 * Normalizes context that the caller has already classified as safe for a
 * public issue. This function deliberately does not redact or inspect values:
 * callers must pass fixed product copy, stable codes, and broad source names.
 */
export function createReportIssueContext(input: {
  readonly title: string;
  readonly message: string | null;
  readonly code: string | null;
  readonly source: string | null;
}): ReportIssueContext {
  return {
    title: normalizeReportContextValue(input.title) ?? "Traycer error",
    message: normalizeReportContextValue(input.message),
    code: normalizeReportContextValue(input.code),
    source: normalizeReportContextValue(input.source),
  };
}

function normalizeReportContextValue(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return null;
  if (normalized.length <= MAX_REPORT_CONTEXT_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_REPORT_CONTEXT_LENGTH - 1)}…`;
}
