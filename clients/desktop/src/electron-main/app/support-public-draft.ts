import type {
  SupportBugReportDraftFields,
  SupportBuildPublicDraftResult,
  SupportCapturedField,
  SupportContextRegistrySnapshot,
  SupportFeatureRequestDraftFields,
  SupportGeneralDraftFields,
  SupportPrivateDiagnostics,
  SupportPrivateDiagnosticsCause,
  SupportPrivateOutcome,
  SupportReportFrequency,
  SupportReportType,
} from "../../ipc-contracts/window-types";
import { scrubSupportText } from "./support-scrubber";

/**
 * Pure field composition + title derivation behind `support:buildPublicDraft`
 * (ticket 09 / T6, extended by ticket 07's type-to-template routing). Kept
 * separate from `support.ts` so this - the actual public-text mechanism - is
 * testable without mocking Electron/Sentry: the service class only resolves
 * frozen evidence and hands this module plain data.
 */

const COMPONENT_DESKTOP_APP = "Desktop app";
const GENERIC_FALLBACK_TITLE = "Traycer desktop issue";
// Titles are meant to stay short; a raw error message or intent sentence can
// run to a full paragraph, so both are capped independently of the overall
// URL budget below.
const TITLE_MAX_CHARS = 80;
const PLACEHOLDER_NO_REPORT = "Filed from the in-app reporter.";

const ISSUE_FORM_MAX_URL_LENGTH = 8 * 1024;
// `issue-reporter.ts` (clients/shared, Vite-bundled renderer code) assembles
// the real URL as `${TRAYCER_OSS_REPO}/issues/new?template=<name>.yml&
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

const FREQUENCY_LABELS: Readonly<Record<SupportReportFrequency, string>> = {
  once: "Once",
  sometimes: "Sometimes",
  every_time: "Every time",
  not_sure: "Not sure",
};

export interface BuildPublicDraftInput {
  readonly type: SupportReportType;
  // The single "What were you trying to do?" question - the only user
  // narrative captured (title/steps/expected/actual were killed in ticket 07).
  readonly intent: string;
  readonly frequency: SupportReportFrequency | null;
  readonly appVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly hostVersion: string | null;
  // Null when frozen evidence was never resolved (e.g. a discarded draft) -
  // every placeholder field falls back to the report-id-free copy.
  readonly reportId: string | null;
  readonly privateDiagnostics: SupportPrivateDiagnostics | undefined;
  // Count only (ticket 08 / T5) - the images themselves never reach the
  // public draft; this just drives the "N screenshot(s) attached to the
  // private report" line below.
  readonly imageCount: number;
  // What (if anything) the private channel actually did with this draft -
  // controls whether the report-ID reference, the repro/proposal
  // placeholder, and the screenshot-count line may honestly point at a
  // private report at all. See `SupportPrivateOutcome`.
  readonly privateOutcome: SupportPrivateOutcome;
  // The user's as-typed preview-title edit, when re-invoking the builder to
  // open the GitHub draft (not the initial preview fetch, where this is
  // null and the title is derived normally). Always re-scrubbed and re-fit
  // through the same budget pipeline as a derived title - `issue-reporter.ts`
  // is assembly-only and must never see raw, unbounded user text.
  readonly overrideTitle: string | null;
}

export function buildPublicDraftFields(
  input: BuildPublicDraftInput,
): SupportBuildPublicDraftResult {
  const cause = input.privateDiagnostics?.cause;
  const title = resolveTitle(input.overrideTitle, input.intent, cause);
  const body = composeReportBody({
    narrative: scrubSupportText(input.intent),
    environmentSummary: composeEnvironmentSummary({
      appVersion: input.appVersion,
      platform: input.platform,
      arch: input.arch,
      hostVersion: input.hostVersion,
      registry: input.privateDiagnostics?.registry,
    }),
    frequency: input.frequency,
    reportId: input.reportId,
    imageCount: input.imageCount,
    privateOutcome: input.privateOutcome,
  });

  switch (input.type) {
    case "bug": {
      const fitted = fitFieldsToUrlBudget(
        {
          title,
          "what-happened": body,
          version: scrubSupportText(input.appVersion),
          os: scrubSupportText(`${input.platform} (${input.arch})`),
          component: COMPONENT_DESKTOP_APP,
          repro: composePlaceholderField(
            "Not captured step-by-step",
            input.reportId,
            input.privateOutcome,
          ),
        },
        ["what-happened", "repro", "title"],
      );
      const fields: SupportBugReportDraftFields = {
        "what-happened": fitted.fields["what-happened"],
        version: fitted.fields.version,
        os: fitted.fields.os,
        component: fitted.fields.component,
        repro: fitted.fields.repro,
      };
      return {
        template: "bug_report.yml",
        title: fitted.fields.title,
        fields,
        truncated: fitted.truncated,
      };
    }
    case "idea": {
      const fitted = fitFieldsToUrlBudget(
        {
          title,
          problem: body,
          proposal: composePlaceholderField(
            "Not captured separately",
            input.reportId,
            input.privateOutcome,
          ),
          alternatives: "",
          component: COMPONENT_DESKTOP_APP,
        },
        ["problem", "proposal", "title"],
      );
      const fields: SupportFeatureRequestDraftFields = {
        problem: fitted.fields.problem,
        proposal: fitted.fields.proposal,
        alternatives: fitted.fields.alternatives,
        component: fitted.fields.component,
      };
      return {
        template: "feature_request.yml",
        title: fitted.fields.title,
        fields,
        truncated: fitted.truncated,
      };
    }
    case "other": {
      const fitted = fitFieldsToUrlBudget({ title, details: body }, [
        "details",
        "title",
      ]);
      const fields: SupportGeneralDraftFields = {
        details: fitted.fields.details,
      };
      return {
        template: "general.yml",
        title: fitted.fields.title,
        fields,
        truncated: fitted.truncated,
      };
    }
  }
}

function capturedFieldValue<T>(
  field: SupportCapturedField<T> | undefined,
): T | null {
  if (field === undefined || field.status === "unavailable") return null;
  return field.value;
}

// "Traycer 1.1.9 · macOS arm64 · host 1.1.9 · Claude / Opus" - every value
// traces back to main's own snapshot/registry (never renderer-composed), so
// this is the single place that line is assembled.
function composeEnvironmentSummary(input: {
  readonly appVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly hostVersion: string | null;
  readonly registry: SupportContextRegistrySnapshot | undefined;
}): string {
  const harness = capturedFieldValue(input.registry?.harnessId);
  const model = capturedFieldValue(input.registry?.model);
  const harnessModel =
    harness !== null && model !== null
      ? `${harness} / ${model}`
      : (harness ?? model);
  const parts = [
    `Traycer ${input.appVersion}`,
    `${input.platform} ${input.arch}`,
    input.hostVersion !== null ? `host ${input.hostVersion}` : null,
    harnessModel,
  ].filter((part): part is string => part !== null);
  return scrubSupportText(parts.join(" · "));
}

// The richer publish body (tech-plan T4): the user's narrative, a sanitized
// environment summary, frequency (if given), the support report id, and
// (ticket 08) whether screenshots were attached - folded into whichever
// template field carries the narrative (what-happened for bug, problem for
// idea, details for other), since GitHub issue forms take one text box per
// field, not a separate box per line here.
//
// Every reference to the report id or an attachment is honest about
// `privateOutcome`: "none" means nothing was ever uploaded (no-DSN, or a
// definite `failed` submit) - there is no private report to point readers
// at, so the report-ID line and the screenshot-count line are both omitted
// entirely rather than pointing at an id nothing was ever filed under.
function composeReportBody(input: {
  readonly narrative: string;
  readonly environmentSummary: string;
  readonly frequency: SupportReportFrequency | null;
  readonly reportId: string | null;
  readonly imageCount: number;
  readonly privateOutcome: SupportPrivateOutcome;
}): string {
  const frequencyLine =
    input.frequency !== null
      ? `Frequency: ${FREQUENCY_LABELS[input.frequency]}`
      : null;
  const reportLine =
    input.privateOutcome !== "none" && input.reportId !== null
      ? `Support report: ${reportReferenceText(input.reportId, input.privateOutcome)}`
      : null;
  const metaLine = [frequencyLine, reportLine]
    .filter((line): line is string => line !== null)
    .join(" · ");
  // Never "N screenshots attached" bare - a public reader must not learn
  // image content exists without also learning where it actually lives
  // (never here, never the GitHub URL - only the private report, and only
  // when a private report actually exists to hold them).
  const attachmentLine =
    input.privateOutcome === "none"
      ? null
      : attachmentLineFor(input.imageCount);
  return [
    input.narrative.trim(),
    `Environment: ${input.environmentSummary}`,
    metaLine,
    attachmentLine,
  ]
    .filter((section): section is string => section !== null)
    .filter((section) => section.trim() !== "")
    .join("\n\n");
}

// "rpt_x" when delivered, "rpt_x (upload unconfirmed)" when the transport
// never confirmed - honest about what state the reader would actually find
// if they went looking, never a bare id that implies certainty this module
// does not have.
function reportReferenceText(
  reportId: string,
  privateOutcome: "delivered" | "unconfirmed",
): string {
  return privateOutcome === "delivered"
    ? reportId
    : `${reportId} (upload unconfirmed)`;
}

function attachmentLineFor(imageCount: number): string | null {
  if (imageCount <= 0) return null;
  const noun = imageCount === 1 ? "screenshot" : "screenshots";
  return `${imageCount} ${noun} attached to the private report.`;
}

// Shared shape for a required template field this ticket has no direct UI
// capture for (bug's `repro`, idea's `proposal`): points at the private
// report rather than silently leaving the field's own required validation to
// block the organic-filer flow it also serves - but only when a private
// report actually exists to point at (`privateOutcome !== "none"`); the
// no-DSN and definite-failure routes fall back to the generic placeholder
// even when a `reportId` happens to be known (frozen evidence resolved but
// nothing was ever uploaded under it).
function composePlaceholderField(
  whatWasNotCaptured: string,
  reportId: string | null,
  privateOutcome: SupportPrivateOutcome,
): string {
  if (reportId !== null && privateOutcome !== "none") {
    return `${whatWasNotCaptured} - see the private support report ${reportReferenceText(reportId, privateOutcome)}.`;
  }
  return PLACEHOLDER_NO_REPORT;
}

/**
 * `overrideTitle` is the user's as-typed preview-title edit, re-submitted
 * when they click "Open GitHub draft" - it must go through the exact same
 * scrub-and-cap treatment as a derived title (`truncatedTitleText`) rather
 * than riding into `fitFieldsToUrlBudget` raw, or a path/token typed into the
 * preview would reach the URL verbatim and unbounded (`issue-reporter.ts` is
 * assembly-only by design and does no scrubbing of its own). An override that
 * scrubs down to nothing (the user cleared the field) falls back to the
 * generic title rather than shipping an empty one.
 */
function resolveTitle(
  overrideTitle: string | null,
  intent: string,
  cause: SupportPrivateDiagnosticsCause | null | undefined,
): string {
  if (overrideTitle === null) return deriveTitle(intent, cause);
  const scrubbed = truncatedTitleText(overrideTitle);
  return scrubbed !== "" ? scrubbed : GENERIC_FALLBACK_TITLE;
}

/**
 * "Chat error"-style bare category titles must be impossible (tech-plan T6):
 * whenever an error envelope exists, the result always leads with the
 * failing operation and/or a stable symptom (an error code, or a short
 * scrubbed slice of the message) ahead of the user's own intent text - never
 * category-only. With no cause at all (manual reports have no error envelope
 * to derive from), the user's own words (the intent question) are the title;
 * that is the honest signal there, not a defect this guardrail covers.
 */
function deriveTitle(
  intent: string,
  cause: SupportPrivateDiagnosticsCause | null | undefined,
): string {
  const intentTitle = truncatedTitleText(intent);
  if (cause === null || cause === undefined) {
    return intentTitle !== "" ? intentTitle : GENERIC_FALLBACK_TITLE;
  }
  const distinctiveToken = distinctiveTitleToken(cause);
  if (distinctiveToken === null) {
    return intentTitle !== "" ? intentTitle : GENERIC_FALLBACK_TITLE;
  }
  return intentTitle !== ""
    ? truncatedTitleText(`${distinctiveToken}: ${intentTitle}`)
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
// preferred over the message; a message's first line is the fallback.
function symptomToken(cause: SupportPrivateDiagnosticsCause): string | null {
  const errorCode = nonEmptyScrubbed(cause.errorCode);
  if (errorCode !== null) return errorCode;
  const firstLine = cause.message.split("\n")[0] ?? "";
  const truncated = truncatedTitleText(firstLine);
  return truncated === "" ? null : truncated;
}

function nonEmptyScrubbed(value: string | null): string | null {
  if (value === null) return null;
  const scrubbed = scrubSupportText(value).trim();
  return scrubbed === "" ? null : scrubbed;
}

function truncatedTitleText(value: string): string {
  const scrubbed = scrubSupportText(value).trim();
  if (scrubbed === "") return "";
  return scrubbed.length > TITLE_MAX_CHARS
    ? `${scrubbed.slice(0, TITLE_MAX_CHARS)}…`
    : scrubbed;
}

// Binary-searches each shrinkable field (in the given, largest/most-likely-
// oversized-first order, "title" included as just another key) down to the
// longest prefix whose truncated-plus-marker form keeps the whole encoded
// param set within budget, measuring the actual percent-encoded length each
// step rather than assuming an encoding-expansion ratio. Operates on a plain
// string-keyed bag - not a template's concrete field interface - so
// bug/idea/other's differently-shaped field records share one implementation;
// each call site reconstructs its own typed result from the returned bag.
function fitFieldsToUrlBudget(
  fields: Readonly<Record<string, string>>,
  shrinkOrder: ReadonlyArray<string>,
): { readonly fields: Record<string, string>; readonly truncated: boolean } {
  let current = { ...fields };
  let truncated = false;
  const encodedLength = (): number =>
    new URLSearchParams(current).toString().length;
  for (const key of shrinkOrder) {
    if (encodedLength() <= ISSUE_FORM_FIELD_BUDGET) break;
    const shrunk = truncateToFit(
      current[key] ?? "",
      (candidate) =>
        new URLSearchParams({ ...current, [key]: candidate }).toString().length,
    );
    current = { ...current, [key]: shrunk };
    truncated = true;
  }
  return { fields: current, truncated };
}

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
