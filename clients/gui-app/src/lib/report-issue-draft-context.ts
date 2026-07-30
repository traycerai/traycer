import {
  createReportIssueContext,
  type ReportIssueContext,
} from "@/lib/report-issue-context";
import {
  computeReportIssueFingerprintV1,
  normalizeStackFamily,
} from "@/lib/report-issue-fingerprint";
import {
  getSupportContextSnapshot,
  type SupportContextSnapshot,
} from "@/lib/support-context-registry";

/**
 * Structured private cause for an error-triggered report. Real error text
 * lives ONLY here, never in {@link ReportIssueContext} (the public prefill) -
 * see `ReportIssueDraftContext`.
 *
 * Guardrail G9: this is the single nullable field the redesign adds for
 * surfaces that DO have a cause. It is not a new function parameter, so the
 * ~160 existing `createReportIssueContext`/`reportableErrorToast` call sites
 * that only ever pass a plain {@link ReportIssueContext} are untouched; only
 * the migrated surfaces (block-error-boundary, app-error-screen) construct
 * one of these.
 */
export interface PrivateErrorCause {
  /** e.g. `error.name`, or a boundary-declared discriminant. */
  readonly type: string;
  readonly message: string;
  readonly stack: string | null;
  readonly componentStack: string | null;
  /** App-defined error code, never raw text. */
  readonly errorCode: string | null;
  /** The action/operation in flight when the error occurred. */
  readonly sourceAction: string | null;
  readonly timestamp: number;
}

export interface ReportIssuePrivateDiagnostics {
  readonly cause: PrivateErrorCause | null;
  readonly registry: SupportContextSnapshot;
  readonly fingerprint: string | null;
  readonly correlationId: string;
}

/**
 * Draft context assembled once at report-open: `publicPrefill` is the
 * existing caller-declared public-safe contract (unchanged);
 * `privateDiagnostics` is the new private branch. Ticket 04 owns the IPC wire
 * shape that carries `privateDiagnostics` to Electron main; this module
 * exports {@link serializeReportIssuePrivateDiagnostics} as the plain-JSON
 * shape for that wire to plug into.
 */
export interface ReportIssueDraftContext {
  readonly publicPrefill: ReportIssueContext;
  readonly privateDiagnostics: ReportIssuePrivateDiagnostics;
}

export function isReportIssueDraftContext(
  value: ReportIssueContext | ReportIssueDraftContext,
): value is ReportIssueDraftContext {
  return "publicPrefill" in value;
}

function readCapturedString(
  field: SupportContextSnapshot["harnessId"],
): string | null {
  return field.status === "unavailable" ? null : field.value;
}

/**
 * Assembles the full draft context from an already-normalized public prefill
 * plus an optional cause: pulls the current support-context registry
 * snapshot (D5), computes the `fp:v1` fingerprint when a cause exists (C8),
 * and mints a fresh correlation id shared between this draft and the
 * renderer error event that produced `cause`.
 */
export function buildReportIssueDraftContext(
  publicPrefill: ReportIssueContext,
  cause: PrivateErrorCause | null,
): ReportIssueDraftContext {
  const registry = getSupportContextSnapshot();
  const fingerprint =
    cause === null
      ? null
      : computeReportIssueFingerprintV1({
          subtype: cause.type,
          errorCode: cause.errorCode,
          operation: cause.sourceAction,
          causalProvider: readCapturedString(registry.harnessId),
          normalizedStackFamily: normalizeStackFamily(cause.stack),
        });
  return {
    publicPrefill,
    privateDiagnostics: {
      cause,
      registry,
      fingerprint,
      correlationId: crypto.randomUUID(),
    },
  };
}

/**
 * Convenience factory for the migrated error surfaces: takes the same input
 * shape as `createReportIssueContext` plus a `cause`, and returns the fully
 * assembled draft. `cause`'s real message/stack reaches only
 * `privateDiagnostics` - `publicPrefill` goes through the unchanged
 * `createReportIssueContext` normalization exactly as before.
 */
export function createReportIssueDraftContext(input: {
  readonly title: string;
  readonly message: string | null | undefined;
  readonly code: string | null | undefined;
  readonly source: string | null | undefined;
  readonly cause: PrivateErrorCause | null;
}): ReportIssueDraftContext {
  return buildReportIssueDraftContext(
    createReportIssueContext(input),
    input.cause,
  );
}

/**
 * Plain-JSON shape of {@link ReportIssuePrivateDiagnostics}. Exported
 * separately (rather than trusting callers to serialize the interface ad
 * hoc) so the exact field list is a single, testable contract for ticket 04's
 * IPC wire shape to match: `cause` (type/message/stack/componentStack/
 * errorCode/sourceAction/timestamp), `registry`, `fingerprint`,
 * `correlationId`.
 */
export type SerializedReportIssuePrivateDiagnostics =
  ReportIssuePrivateDiagnostics;

export function serializeReportIssuePrivateDiagnostics(
  diagnostics: ReportIssuePrivateDiagnostics,
): SerializedReportIssuePrivateDiagnostics {
  return {
    cause: diagnostics.cause === null ? null : { ...diagnostics.cause },
    registry: { ...diagnostics.registry },
    fingerprint: diagnostics.fingerprint,
    correlationId: diagnostics.correlationId,
  };
}
