import { attestTraycerRegistration, type TraycerLabelIds } from "../identity";
import type { ProbeCommandResult } from "../shared/command";
import { combinedOutput } from "../shared/command";
import {
  SMAPPSERVICE_PATH_UNKNOWN,
  SERVICE_MANAGEMENT_JOB_TYPE,
  SERVICE_MANAGEMENT_MANAGED_BY,
  type LabelOwnership,
  type LaunchctlPrintProbe,
  type LaunchdRunState,
  type LwcrEvidence,
  type MacosEvidence,
  type SmAppServiceSignals,
} from "./types";

/**
 * Collect **top-level** `key = value` pairs from `launchctl print` output.
 * Block-opening lines (`arguments = {`) are pairs syntactically but not semantically: they announce a nested section rather than carry a value, and admitting them mapped container keys to the literal `"{"`.
 */
export function parseLaunchctlPrintFields(
  printOutput: string,
): ReadonlyMap<string, string> {
  const fields = new Map<string, string>();
  for (const line of printOutput.split("\n")) {
    const match = line.match(
      /^\t?([A-Za-z_][A-Za-z0-9_ ]*?)[ \t]*=(?!>)[ \t]*(.+?)[ \t]*$/,
    );
    if (match === null) continue;
    const key = match[1];
    const rawValue = match[2];
    if (key === undefined || rawValue === undefined) {
      continue;
    }
    // Trim so whitespace-only values are treated as empty (the guard below is intentionally live - without trim, `.+?` would keep a single trailing space and the empty check would never fire).
    const value = rawValue.trim();
    if (value.length === 0) {
      continue;
    }
    // Block opener, not a value.
    if (value === "{") {
      continue;
    }
    if (!fields.has(key)) fields.set(key, value);
  }
  return fields;
}

export function isSmAppServiceLaunchAgentPath(plistPath: string): boolean {
  return /\/[^/]+\.app\/Contents\/Library\/LaunchAgents\//i.test(plistPath);
}

export function classifyLabelOwnership(
  fields: ReadonlyMap<string, string>,
  raw: string,
  knownLabels: TraycerLabelIds | null,
  labelId: string | null,
): LabelOwnership {
  const pathRaw = fields.get("path") ?? null;
  const managedBy = fields.get("managed_by");
  const type = fields.get("type");
  const signals: SmAppServiceSignals = {
    managedByServiceManagement: managedBy === SERVICE_MANAGEMENT_MANAGED_BY,
    typeSubmitted: type === SERVICE_MANAGEMENT_JOB_TYPE,
    inBundleLaunchAgentPath:
      pathRaw !== null && isSmAppServiceLaunchAgentPath(pathRaw),
  };

  const isServiceManagement =
    signals.managedByServiceManagement ||
    signals.typeSubmitted ||
    signals.inBundleLaunchAgentPath;

  if (isServiceManagement) {
    return {
      kind: "smappservice",
      path: pathRaw ?? SMAPPSERVICE_PATH_UNKNOWN,
      signals,
    };
  }

  // No SMAppService signals. If we have *some* recognizable job fields,
  // treat as cli-or-other with identity attestation from the same bytes.
  const hasJobShape =
    pathRaw !== null ||
    fields.has("state") ||
    fields.has("pid") ||
    fields.has("program") ||
    type === "LaunchAgent";

  if (!hasJobShape) {
    return {
      kind: "indeterminate",
      cause: "unrecognized-format",
      path: pathRaw,
    };
  }

  const programArgs = extractProgramArgumentsFromPrint(raw);
  const identity = attestTraycerRegistration({
    labelId,
    knownLabels,
    programArguments: programArgs,
    contentTag: null,
    sourceText: raw,
  });

  return {
    kind: "cli-or-other",
    path: pathRaw,
    identity,
  };
}

export function extractProgramArgumentsFromPrint(
  raw: string,
): readonly string[] | null {
  const lines = raw.split("\n");
  const openIndex = lines.findIndex((line) =>
    /^\s*(?:program\s+)?arguments\s*=\s*\{\s*$/i.test(line),
  );

  if (openIndex === -1) {
    // Single-line form: `program arguments = { "host" "start" }`.
    const inline = raw.match(/(?:program\s+)?arguments\s*=\s*\{([^}\n]*)\}/i);
    const body = inline?.[1];
    if (body === undefined) return null;
    const tokens = splitInlineArgumentTokens(body);
    return tokens.length > 0 ? tokens : null;
  }

  const tokens: string[] = [];
  for (const line of lines.slice(openIndex + 1)) {
    if (/^\s*\}\s*$/.test(line)) {
      return tokens.length > 0 ? tokens : null;
    }
    const token = stripSurroundingQuotes(line.trim());
    if (token.length === 0) continue;
    tokens.push(token);
  }
  // Block never closed - truncated output is not evidence about arguments.
  return null;
}

function splitInlineArgumentTokens(body: string): readonly string[] {
  const quoted = [...body.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? "");
  if (quoted.length > 0) return quoted;
  return body
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function stripSurroundingQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Only exact mismatch tokens, currently `needs LWCR update`. `has LWCR` is healthy; a bare `lwcr` substring matches paths.
 * Adding a token requires live `launchctl print` bytes from a wedged job.
 */
const LWCR_MISMATCH_MARKERS: readonly string[] = ["needs LWCR update"];

export function parseLaunchdRunState(raw: string): LaunchdRunState {
  const fields = parseLaunchctlPrintFields(raw);
  return {
    jobState: evidenceString(fields, ["state", "job state"]),
    lastExitCode: evidenceNumber(fields, [
      "last exit code",
      "last exit status",
    ]),
    lastExitReason: evidenceString(fields, [
      "last exit reason",
      "last termination reason",
    ]),
    pid: evidenceNumber(fields, ["pid"]),
    runs: evidenceNumber(fields, ["runs"]),
    lwcr: parseLwcrEvidence(raw),
  };
}

function evidenceString(
  fields: ReadonlyMap<string, string>,
  keys: readonly string[],
): MacosEvidence<string> {
  for (const key of keys) {
    const v = fields.get(key);
    if (v !== undefined && v.length > 0) {
      return { kind: "observed", value: v };
    }
  }
  return { kind: "absent" };
}

function evidenceNumber(
  fields: ReadonlyMap<string, string>,
  keys: readonly string[],
): MacosEvidence<number> {
  for (const key of keys) {
    const v = fields.get(key);
    if (v === undefined) continue;
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n)) {
      return { kind: "observed", value: n };
    }
  }
  return { kind: "absent" };
}

/**
 * Read LWCR markers from the `properties` field, not the whole print blob (paths/args can carry the substring).
 * No `properties` field is `indeterminate`, not `absent` - an unread field must not wedge.
 */
export function parseLwcrEvidence(raw: string): LwcrEvidence {
  const properties = parseLaunchctlPrintFields(raw).get("properties");
  if (properties === undefined) {
    return { kind: "indeterminate", cause: "unrecognized-format" };
  }
  const lower = properties.toLowerCase();
  const found: string[] = [];
  for (const marker of LWCR_MISMATCH_MARKERS) {
    if (lower.includes(marker.toLowerCase())) {
      found.push(marker);
    }
  }
  if (found.length === 0) {
    return { kind: "absent" };
  }
  return { kind: "observed", markers: found };
}

/**
 * Classify a finished `launchctl print` process result.
 * Non-zero must split absent (not-found signatures) vs indeterminate.
 */
export function classifyLaunchctlPrintResult(
  result: ProbeCommandResult,
  knownLabels: TraycerLabelIds | null,
  labelId: string | null,
): LaunchctlPrintProbe {
  if (result.spawnFailed) {
    return { kind: "indeterminate", cause: "spawn-failed" };
  }
  if (result.timedOut) {
    return { kind: "indeterminate", cause: "timeout" };
  }

  const raw = combinedOutput(result);

  if (result.exitCode !== 0) {
    if (isLaunchctlNotFoundOutput(raw)) {
      return { kind: "absent" };
    }
    if (isLaunchctlPermissionOutput(raw)) {
      return { kind: "indeterminate", cause: "permission" };
    }
    return { kind: "indeterminate", cause: "command-failed" };
  }

  const fields = parseLaunchctlPrintFields(raw);
  const ownership = classifyLabelOwnership(fields, raw, knownLabels, labelId);
  const runState = parseLaunchdRunState(raw);
  return {
    kind: "observed",
    raw,
    fields,
    ownership,
    runState,
  };
}

/**
 * Locale-tolerant "service not found" class. Exact strings across macOS
 * 13–26 remain unknown-pending-live-probe; we match the English stems
 * used by today's CLI plus a few observed variants without inventing
 * platform-specific enums beyond this classifier.
 */
export function isLaunchctlNotFoundOutput(output: string): boolean {
  const hay = output.toLowerCase();
  return (
    hay.includes("could not find service") ||
    hay.includes("could not find specified service") ||
    hay.includes("no such process") ||
    hay.includes("service could not be found") ||
    hay.includes("unrecognized domain or target") ||
    /error\s*0x\s*44/i.test(output) // ESRCH-ish codes sometimes printed
  );
}

export function isLaunchctlPermissionOutput(output: string): boolean {
  const hay = output.toLowerCase();
  return (
    hay.includes("operation not permitted") ||
    hay.includes("permission denied") ||
    hay.includes("not privileged") ||
    hay.includes("eperm")
  );
}
