const FINGERPRINT_VERSION = "fp:v1";

export interface ReportIssueFingerprintInputV1 {
  /** App-defined error code (e.g. a `HostRpcError.code`), never raw text. */
  readonly errorCode: string | null;
  /** The failing operation/action, e.g. `chat.subscribe`. */
  readonly operation: string | null;
  /** Causal provider or harness id (e.g. `claude-code`), never a version. */
  readonly causalProvider: string | null;
  /** Typed defect subtype, e.g. an `Error.name` or a boundary-declared kind. */
  readonly subtype: string;
}

/**
 * Reduces a raw stack trace to an ordered list of frame identifiers (function
 * names only - no file paths, line/column numbers, or absolute paths), so the
 * SAME defect fingerprints identically across app versions and platforms
 * whose bundling shifts line numbers. Returns `null` for a missing/empty
 * stack; anonymous frames collapse to `"<anonymous>"` rather than being
 * dropped, so frame *position* still contributes to the family.
 */
export function normalizeStackFamily(stack: string | null): string | null {
  if (stack === null) return null;
  const frames = stack
    .split("\n")
    .slice(1) // first line is the error's own `name: message`, not a frame.
    .map((line) => extractFrameName(line))
    .filter((name): name is string => name !== null);
  if (frames.length === 0) return null;
  return frames.join(">");
}

const FRAME_WITH_NAME_RE = /^\s*at\s+([^(]+?)\s*\(/;

/**
 * `null` for a line that is not a stack frame at all (filtered out);
 * `"<anonymous>"` for a genuine frame with no function name - V8 renders
 * those as a bare `at path:line:col` with no parens - so frame position
 * still contributes even when the function itself is anonymous.
 */
function extractFrameName(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("at ")) return null;
  const match = FRAME_WITH_NAME_RE.exec(line);
  if (match === null) return "<anonymous>";
  const name = match[1].trim();
  return name.length === 0 ? "<anonymous>" : name;
}

/**
 * Deterministic 32-bit string hash (djb2). Not cryptographic - fingerprints
 * only need to be stable and well-distributed, not collision-resistant
 * against an adversary.
 */
function djb2(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Computes the versioned `fp:v1:<hash>` fingerprint (critique C8). Identity is
 * error code + operation + causal provider/harness + typed subtype ONLY - the
 * parts that survive a fix. Stack shape does NOT enter this hash at all: a
 * one-frame refactor must never re-identify a defect. The normalized stack
 * family is exposed as a separate `stackFamily` field on the serialized
 * diagnostics (see `report-issue-draft-context.ts`) for maintainer-side
 * sub-clustering, never folded into identity. App/host versions and platform
 * are also NOT inputs here - they are facets, attached as separate Sentry
 * tags, never part of identity.
 */
export function computeReportIssueFingerprintV1(
  input: ReportIssueFingerprintInputV1,
): string {
  const identity = [
    input.subtype,
    input.errorCode ?? "no-code",
    input.operation ?? "no-operation",
    input.causalProvider ?? "no-provider",
  ].join("|");
  return `${FINGERPRINT_VERSION}:${djb2(identity)}`;
}
