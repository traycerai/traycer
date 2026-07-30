import type {
  SupportBuildPublicDraftResult,
  SupportPrivateDiagnostics,
  SupportPrivateDiagnosticsCause,
} from "../../ipc-contracts/window-types";
import { scrubSupportText } from "./support-scrubber";

/**
 * Pure field composition + title derivation behind `support:buildPublicDraft`
 * (ticket 09 / T6). Kept separate from `support.ts` so this - the actual
 * public-text mechanism - is testable without mocking Electron/Sentry: the
 * service class only resolves frozen evidence and hands this module plain
 * data.
 */

const COMPONENT_DESKTOP_APP = "Desktop app";
const GENERIC_FALLBACK_TITLE = "Traycer desktop issue";
// Titles are meant to stay short; a raw error message can run to a full
// sentence or more, so the symptom token is capped independently of the
// overall URL budget below.
const TITLE_SYMPTOM_MAX_CHARS = 80;
const REPRO_PLACEHOLDER_NO_REPORT = "Filed from the in-app reporter.";

const ISSUE_FORM_MAX_URL_LENGTH = 8 * 1024;
// `issue-reporter.ts` (clients/shared, Vite-bundled renderer code) assembles
// the real URL as `${TRAYCER_OSS_REPO}/issues/new?template=bug_report.yml&
// title=...&...`. This module runs in Electron main, which has no access to
// `VITE_TRAYCER_OSS_REPO` (a Vite-only `import.meta.env` binding) and so
// cannot build or measure the real, final URL - only `issue-reporter.ts` can.
// Rather than duplicate that env plumbing into the main-process build config
// (`config.ts`) for one constant, this reserves conservative headroom for
// everything it cannot see (the repo origin, `/issues/new?`, and the
// `template=` param): that total runs under 200 bytes today, so 1 KiB of
// margin is generous. As long as that holds, fitting fields to
// `ISSUE_FORM_MAX_URL_LENGTH - ISSUE_FORM_RESERVED_OVERHEAD_BYTES` guarantees
// the real, fully-assembled URL `issue-reporter.ts` produces never exceeds
// the 8 KiB budget - `issue-reporter.ts` itself does no truncation of its own.
const ISSUE_FORM_RESERVED_OVERHEAD_BYTES = 1024;
const ISSUE_FORM_FIELD_BUDGET =
  ISSUE_FORM_MAX_URL_LENGTH - ISSUE_FORM_RESERVED_OVERHEAD_BYTES;
const TRUNCATION_MARKER = " (truncated, see support report)";

export interface BuildPublicDraftInput {
  readonly title: string;
  readonly whatHappened: string;
  readonly stepsToReproduce: string;
  readonly expectedBehavior: string;
  readonly actualBehavior: string;
  readonly appVersion: string;
  readonly platform: string;
  readonly arch: string;
  // Null when frozen evidence was never resolved (e.g. a discarded draft) -
  // `composeRepro` falls back to the report-id-free placeholder.
  readonly reportId: string | null;
  readonly privateDiagnostics: SupportPrivateDiagnostics | undefined;
}

export function buildPublicDraftFields(
  input: BuildPublicDraftInput,
): SupportBuildPublicDraftResult {
  const title = deriveTitle(input.title, input.privateDiagnostics?.cause);
  const whatHappened = composeWhatHappened(input);
  const repro = composeRepro(input.stepsToReproduce, input.reportId);
  const version = scrubSupportText(input.appVersion);
  const os = scrubSupportText(`${input.platform} (${input.arch})`);

  const { fields, truncated } = fitToUrlBudget({
    title,
    whatHappened,
    version,
    os,
    component: COMPONENT_DESKTOP_APP,
    repro,
  });
  return {
    title: fields.title,
    fields: {
      "what-happened": fields.whatHappened,
      version: fields.version,
      os: fields.os,
      component: fields.component,
      repro: fields.repro,
    },
    truncated,
  };
}

// The user's own words for what happened, with non-empty expected/actual
// behavior folded in under clear labels rather than silently dropped -
// migrated as-is from the old renderer-side `composeWhatHappened` (ticket 09
// moves this behind the scrub boundary; it does not redesign it).
function composeWhatHappened(input: {
  readonly whatHappened: string;
  readonly expectedBehavior: string;
  readonly actualBehavior: string;
}): string {
  const whatHappened = scrubSupportText(input.whatHappened);
  const expected = scrubSupportText(input.expectedBehavior).trim();
  const actual = scrubSupportText(input.actualBehavior).trim();
  return [
    whatHappened,
    expected === "" ? "" : `Expected: ${expected}`,
    actual === "" ? "" : `Actual: ${actual}`,
  ]
    .filter((section) => section.trim() !== "")
    .join("\n\n");
}

// The form's `repro` field stays required for organic filers. A report id
// now always exists once evidence has been frozen (T2), so an empty draft
// points at it by name instead of the report-id-less placeholder ticket 01
// shipped before report ids existed.
function composeRepro(
  stepsToReproduce: string,
  reportId: string | null,
): string {
  const scrubbedSteps = scrubSupportText(stepsToReproduce).trim();
  if (scrubbedSteps !== "") return scrubbedSteps;
  if (reportId !== null) {
    return `Not captured step-by-step - see the private support report ${reportId}.`;
  }
  return REPRO_PLACEHOLDER_NO_REPORT;
}

/**
 * "Chat error"-style bare category titles must be impossible (tech-plan T6):
 * whenever an error envelope exists, the result always leads with the
 * failing operation and/or a stable symptom (an error code, or a short
 * scrubbed slice of the message) ahead of the user's own title - never the
 * user's title alone, which is the one field a caller could hand in as a
 * bare category label (`createReportIssueContext`'s own "Traycer error"
 * default is exactly this shape). With no cause at all (manual reports have
 * no error envelope to derive from), the user's own words are the title;
 * that is the honest signal there, not a defect this guardrail covers.
 */
function deriveTitle(
  userTitle: string,
  cause: SupportPrivateDiagnosticsCause | null | undefined,
): string {
  const scrubbedUserTitle = scrubSupportText(userTitle).trim();
  const fallback =
    scrubbedUserTitle !== "" ? scrubbedUserTitle : GENERIC_FALLBACK_TITLE;
  if (cause === null || cause === undefined) return fallback;
  const distinctiveToken = distinctiveTitleToken(cause);
  if (distinctiveToken === null) return fallback;
  return scrubbedUserTitle !== ""
    ? `${distinctiveToken}: ${scrubbedUserTitle}`
    : distinctiveToken;
}

function distinctiveTitleToken(
  cause: SupportPrivateDiagnosticsCause,
): string | null {
  const operation = nonEmptyScrubbed(cause.sourceAction);
  const symptom = symptomToken(cause);
  const parts = [operation, symptom].filter(
    (token): token is string => token !== null,
  );
  return parts.length > 0 ? parts.join(" - ") : null;
}

// Error codes are stable/short by contract (app-defined, never raw text) and
// preferred over the message; a message's first line is the fallback,
// scrubbed and capped since a raw message can run well past title length.
function symptomToken(cause: SupportPrivateDiagnosticsCause): string | null {
  const errorCode = nonEmptyScrubbed(cause.errorCode);
  if (errorCode !== null) return errorCode;
  const firstLine = cause.message.split("\n")[0] ?? "";
  const scrubbed = scrubSupportText(firstLine).trim();
  if (scrubbed === "") return null;
  return scrubbed.length > TITLE_SYMPTOM_MAX_CHARS
    ? `${scrubbed.slice(0, TITLE_SYMPTOM_MAX_CHARS)}…`
    : scrubbed;
}

function nonEmptyScrubbed(value: string | null): string | null {
  if (value === null) return null;
  const scrubbed = scrubSupportText(value).trim();
  return scrubbed === "" ? null : scrubbed;
}

interface DraftFields {
  readonly title: string;
  readonly whatHappened: string;
  readonly version: string;
  readonly os: string;
  readonly component: string;
  readonly repro: string;
}

type ShrinkableField = "whatHappened" | "repro" | "title";

function fitToUrlBudget(initial: DraftFields): {
  readonly fields: DraftFields;
  readonly truncated: boolean;
} {
  let fields = initial;
  let truncated = false;
  // Largest/most-likely-oversized field first: the narrative, then repro
  // (also user-typed and unbounded), then title (short in practice) -
  // ported unchanged from the pre-ticket-09 `issue-reporter.ts` ordering.
  for (const field of ["whatHappened", "repro", "title"] as const) {
    if (encodedFieldsLength(fields) <= ISSUE_FORM_FIELD_BUDGET) break;
    fields = shrinkField(fields, field);
    truncated = true;
  }
  return { fields, truncated };
}

function encodedFieldsLength(fields: DraftFields): number {
  return new URLSearchParams({
    title: fields.title,
    "what-happened": fields.whatHappened,
    version: fields.version,
    os: fields.os,
    component: fields.component,
    repro: fields.repro,
  }).toString().length;
}

function shrinkField(fields: DraftFields, field: ShrinkableField): DraftFields {
  const truncatedValue = truncateToFit(fields[field], (candidate) =>
    encodedFieldsLength({ ...fields, [field]: candidate }),
  );
  return { ...fields, [field]: truncatedValue };
}

// Binary-searches the longest prefix of `value` whose truncated-plus-marker
// form keeps the encoded field length within budget, measuring the actual
// percent-encoded length each step rather than assuming an encoding-expansion
// ratio - ported unchanged from the pre-ticket-09 `issue-reporter.ts`.
function truncateToFit(
  value: string,
  lengthFor: (candidate: string) => number,
): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = `${value.slice(0, mid)}${TRUNCATION_MARKER}`;
    if (lengthFor(candidate) <= ISSUE_FORM_FIELD_BUDGET) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return `${value.slice(0, low)}${TRUNCATION_MARKER}`;
}
