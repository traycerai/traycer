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
 * First occurrence wins; nested `=>` env lines excluded (macos.ts:465-490).
 *
 * Depth is enforced, not assumed. Real `launchctl print` indents top-level
 * fields with exactly one tab and everything inside a `{ … }` block with two
 * or more, so the anchor is `^\t?` — at most one leading tab. The previous
 * `^\s*` anchor matched any depth and harvested `port` / `active` / `managed`
 * / `reset` / `hide` / `watching` out of the `endpoints = { … }` block
 * (30 fields from one real print). First-occurrence-wins hid that today, but
 * `classifyLabelOwnership` reads `fields.get("path")`, and an
 * SMAppService-submitted job need not carry a top-level `path` while nested
 * descriptors can — a nested `path` would then become both the reported
 * `LabelOwnership.path` and the input to `isSmAppServiceLaunchAgentPath`.
 *
 * Block-opening lines (`arguments = {`) are pairs syntactically but not
 * semantically: they announce a nested section rather than carry a value, and
 * admitting them mapped container keys to the literal `"{"`. They are
 * dropped, which is what makes the docstring above true.
 *
 * Value capture uses `.+?` so a bare `key=` with no characters after `=`
 * fails the match entirely (same as today's CLI). A whitespace-only value
 * (`key =   `) does match; we **trim** and drop empty so the empty-value
 * guard is reachable and meaningful for real launchctl-ish shapes.
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
    // Trim so whitespace-only values are treated as empty (the guard below
    // is intentionally live — without trim, `.+?` would keep a single
    // trailing space and the empty check would never fire).
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

/**
 * Multi-signal SMAppService ownership. Any of:
 * 1. managed_by = com.apple.xpc.ServiceManagement
 * 2. type = Submitted
 * 3. in-bundle LaunchAgents path
 */
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

/**
 * ProgramArguments extraction from `launchctl print` text (annex §2.1.2).
 *
 * Real launchd emits arguments **bare, one per line** inside the block:
 *
 * ```
 * 	arguments = {
 * 		Contents/Library/LaunchAgents/Traycer Host.app/Contents/MacOS/traycer
 * 		host
 * 		start
 * 	}
 * ```
 *
 * Harvesting only `"quoted"` tokens returned `null` for **every real job**,
 * and a `null` here does not fail loudly — it silently reduces launchd-derived
 * attestation to label matching alone, which is precisely what `identity.ts`'s
 * header and the annex's eviction rule forbid. Arguments are one per line, and
 * an argument may legally contain spaces (the real Traycer agent's program
 * path does), so the line is the token: no whitespace splitting.
 *
 * Surrounding double quotes are stripped when present so a quoted generation
 * still reads correctly, and the leading `program arguments = {` spelling is
 * accepted alongside `arguments = {`.
 */
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
  // Block never closed — truncated output is not evidence about arguments.
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
 * LWCR **mismatch** markers — annex §1.1 (corrected).
 *
 * Exactly one token, and it is the only one that means anything is wrong.
 * `has LWCR` was in this list and is the *healthy* state: launchd prints it in
 * `properties` for any job with a Lightweight Code Requirement attached, which
 * is the normal state of a code-signed SMAppService agent. The live Traycer
 * agent on a working install prints
 * `properties = partial import | runatload | resolve program | has LWCR`.
 * Treating that as wedge evidence made the steady-state plan for a healthy
 * macOS install `transition-to-fallback` — provision a raw fallback and boot
 * out the agent. The bare substring `"lwcr"` was worse still: it matched any
 * path or argument containing those four letters.
 *
 * Adding a token here requires live `launchctl print` bytes showing it on a
 * job that is actually wedged — never inference from the string's wording.
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
 * LWCR evidence from the **`properties` field**, not the whole print blob
 * (annex §1.1 rule 2). Scanning the blob let any path, argument or coalition
 * name carrying the substring produce a marker.
 *
 * A print with no `properties` field is `indeterminate(unrecognized-format)`,
 * not `absent`: we did not read the property list, so we have not observed the
 * absence of a mismatch marker either. `deriveWedgeVerdict` only raises
 * `lwcr-mismatch-markers` on `observed`, so an unread field cannot wedge.
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
