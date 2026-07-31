import { captureException, isInitialized } from "@sentry/browser";
import {
  computeReportIssueFingerprintV1,
  normalizeStackFamily,
} from "@/lib/report-issue-fingerprint";
import type { PrivateErrorCause } from "@/lib/report-issue-draft-context";
import { getSupportContextSnapshot } from "@/lib/support-context-registry";

export interface ReportIssueErrorCaptureInput {
  /** The original thrown/caught value - forwarded to Sentry as-is. */
  readonly error: unknown;
  readonly componentStack: string | null;
  /** App-defined error code, never raw text. */
  readonly errorCode: string | null;
  /** The action/operation in flight when the error occurred. */
  readonly sourceAction: string | null;
}

export interface ReportIssueErrorCapture {
  readonly cause: PrivateErrorCause;
  readonly correlationId: string;
  /** Always computed - a capture always has a subtype/errorCode/operation to hash. */
  readonly fingerprint: string;
  readonly stackFamily: string | null;
}

function errorTypeName(error: unknown): string {
  if (error instanceof Error) return error.name;
  return typeof error;
}

function readErrorMessage(error: unknown): string | null {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return null;
}

function errorStack(error: unknown): string | null {
  return error instanceof Error ? (error.stack ?? null) : null;
}

/**
 * Captures a renderer error AT THE MOMENT it is caught (boundary
 * `componentDidCatch`, or a function component's idempotent capture adapter -
 * NEVER an unguarded render body, since this mints ids and calls Sentry): mints the
 * correlation id and computes the `fp:v1` fingerprint once, then reports the
 * exception to renderer Sentry tagged with both, so the private report a user
 * files later can be joined back to the actual Sentry event. Call this
 * exactly once per caught error and thread the returned bundle through to
 * `createReportIssueDraftContext`'s `capture` field - re-deriving it at
 * draft-open time would mint a mismatched id and could fingerprint against a
 * session snapshot that has since drifted.
 *
 * Cause presence is gated on whether an error was actually caught, never on
 * whether it has a displayable message: `new Error("")`, a thrown non-Error,
 * and a blank string all still carry a type/stack/componentStack worth an
 * envelope and a fingerprint.
 */
export function captureReportIssueError(
  input: ReportIssueErrorCaptureInput,
): ReportIssueErrorCapture {
  const timestamp = Date.now();
  const type = errorTypeName(input.error);
  const message = readErrorMessage(input.error) ?? "";
  const stack = errorStack(input.error);
  const stackFamily = normalizeStackFamily(stack);
  const registry = getSupportContextSnapshot();
  const causalProvider =
    registry.harnessId.status === "unavailable"
      ? null
      : registry.harnessId.value;
  const fingerprint = computeReportIssueFingerprintV1({
    subtype: type,
    errorCode: input.errorCode,
    operation: input.sourceAction,
    causalProvider,
  });
  const correlationId = crypto.randomUUID();

  // Boundary-caught render errors never reach Sentry's default global
  // handlers (window.onerror / unhandledrejection) - React swallows them
  // before they get there - so this is the only capture that will ever
  // happen for them, never a double-report alongside an automatic one.
  if (isInitialized()) {
    captureException(input.error, {
      tags: {
        correlationId,
        fingerprint,
        errorCode: input.errorCode ?? undefined,
        operation: input.sourceAction ?? undefined,
        causalProvider: causalProvider ?? undefined,
      },
    });
  }

  return {
    cause: {
      type,
      message,
      stack,
      componentStack: input.componentStack,
      errorCode: input.errorCode,
      sourceAction: input.sourceAction,
      timestamp,
    },
    correlationId,
    fingerprint,
    stackFamily,
  };
}
