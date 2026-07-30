import {
  BEARER_PATTERN,
  SENSITIVE_INLINE_VALUE_PATTERN,
  SENSITIVE_KEY_PATTERN,
  SENSITIVE_QUERY_PARAM_PATTERN,
} from "./sensitive-text-patterns";

/**
 * The support-specific scrubber (ticket 09 / tech-plan T6): applied at
 * serialization to every private string, log tail, local diagnostic bundle,
 * and derived title before any of it can leave the machine (Sentry, the
 * local diagnostic bundle file, or the public GitHub draft).
 *
 * Deliberately does NOT reuse `logger.ts`'s `redactLogText`: that helper caps
 * output at 1,000 chars, which would silently truncate exactly the 500-line /
 * 512 KB log tails and multi-KB stack traces this scrubber exists to protect.
 * It reuses the same token/secret/bearer/api-key regexes (`sensitive-text-
 * patterns.ts`) so detection never drifts between the two call sites, then
 * adds a pass `redactLogText` has never had: absolute-path pseudonymization.
 * `host.log` is written with zero redaction at source
 * (`traycer-host/src/bootstrap/host-logger.ts`), so this module is its only
 * line of defense, and paths - workspace directories, usernames, install
 * locations - are the dominant leak vector in that file and in stack traces.
 */

// Recognized filesystem roots for POSIX absolute paths. Anchoring on these
// (rather than matching "any /a/b/c-shaped token") is deliberate: log lines
// routinely carry API-route-looking text ("GET /api/v1/host/status 200")
// that is not a filesystem path and is useful un-redacted, while every real
// leak this scrubber has to stop - workspace/project directories, install
// paths, home directories - lives under one of these roots on a real machine.
const POSIX_PATH_ROOT_NAMES = [
  "Users",
  "home",
  "root",
  "private",
  "var",
  "tmp",
  "opt",
  "etc",
  "Applications",
  "Library",
  "System",
  "mnt",
  "media",
  "usr",
  "srv",
  "data",
  "proc",
] as const;

// A path segment is anything up to whitespace or a character that would
// terminate it in the free-text this runs over: quotes, angle brackets,
// pipes, and backticks (the same boundary `redactLogText`'s own patterns
// use), plus the punctuation stack traces commonly wrap a path in -
// `(/Users/x/y.ts:12:34)` must pseudonymize to `(<path-1>)`, not swallow the
// closing paren into the match and leave it unbalanced.
const PATH_SEGMENT_BOUNDARY =
  String.raw`[^\s"'` + "`" + String.raw`<>|()[\]{},;]`;

const POSIX_ABSOLUTE_PATH_PATTERN = new RegExp(
  String.raw`\/(?:${POSIX_PATH_ROOT_NAMES.join("|")})(?:\/${PATH_SEGMENT_BOUNDARY}*)*`,
  "g",
);

// `C:\Users\...` or `C:/Users/...`. Windows drive letters are not a useful
// anchor set the way POSIX root names are (any letter is valid), so this
// anchors on the drive-letter-colon-separator shape instead. The negative
// lookbehind is load-bearing: without it, the tail of an ordinary
// `https://...` URL ("s" followed by ":" and "/") false-positives as drive
// "S:/" - the lookbehind requires the letter not be preceded by another
// letter/digit, which a real single-letter drive designation never is.
const WINDOWS_ABSOLUTE_PATH_PATTERN = new RegExp(
  String.raw`(?<![A-Za-z0-9])[A-Za-z]:[\\/](?:${PATH_SEGMENT_BOUNDARY}+[\\/]?)*`,
  "g",
);

// `\\server\share\...` UNC paths.
const UNC_PATH_PATTERN = new RegExp(
  String.raw`\\\\${PATH_SEGMENT_BOUNDARY}+`,
  "g",
);

/**
 * Scrubs one line of free text: token/secret/bearer/api-key redaction (same
 * patterns as `redactLogText`), then absolute-path pseudonymization. No
 * length cap - callers enforce their own field bounds AFTER calling this,
 * never before, so a byte/char budget always measures the scrubbed text that
 * will actually ship (see `support.ts`'s log-tail capture and
 * `support-public-draft.ts`'s URL budget).
 */
export function scrubSupportText(text: string): string {
  const pathPseudonyms = new Map<string, string>();
  // Split-map-join per line rather than one global replace over the whole
  // blob: the ticket calls this out explicitly ("applied line-wise") because
  // a multi-hundred-KB log tail is exactly the input `redactLogText`'s
  // whole-string cap was breaking on, and per-line application keeps the
  // regexes working against bounded input regardless of overall tail size.
  return text
    .split("\n")
    .map((line) => scrubLine(line, pathPseudonyms))
    .join("\n");
}

function scrubLine(line: string, pathPseudonyms: Map<string, string>): string {
  const redacted = line
    .replace(SENSITIVE_QUERY_PARAM_PATTERN, "$1<redacted>")
    .replace(BEARER_PATTERN, "Bearer <redacted>")
    .replace(SENSITIVE_INLINE_VALUE_PATTERN, "$1<redacted>");
  return pseudonymizeAbsolutePaths(redacted, pathPseudonyms);
}

/**
 * Replaces every absolute path with an opaque `<path-N>` pseudonym, stable
 * per unique path within one `scrubSupportText` call (the same file
 * appearing in two stack frames collapses to the same token, which keeps
 * "same file in both frames" legible to a maintainer without the path text
 * itself ever surviving). Never keeps the basename: a workspace path's most
 * sensitive segment is routinely the project/client directory name, not just
 * the leading username, so partial retention does not make this safe.
 */
function pseudonymizeAbsolutePaths(
  text: string,
  pathPseudonyms: Map<string, string>,
): string {
  const replace = (match: string): string => {
    const existing = pathPseudonyms.get(match);
    if (existing !== undefined) return existing;
    const pseudonym = `<path-${pathPseudonyms.size + 1}>`;
    pathPseudonyms.set(match, pseudonym);
    return pseudonym;
  };
  return text
    .replace(UNC_PATH_PATTERN, replace)
    .replace(WINDOWS_ABSOLUTE_PATH_PATTERN, replace)
    .replace(POSIX_ABSOLUTE_PATH_PATTERN, replace);
}

const MAX_DEEP_SCRUB_DEPTH = 6;
const MAX_DEEP_SCRUB_ARRAY_ITEMS = 200;
const MAX_DEEP_SCRUB_OBJECT_KEYS = 100;

/**
 * Recursively scrubs every string value in an arbitrary JSON-like structure -
 * the mechanism behind "every private string and context", not just the flat
 * log-tail text `scrubSupportText` handles alone. Used on the Sentry
 * `contexts` record and the local diagnostic bundle, both of which nest
 * error causes, layer0 records, and process metrics several levels deep.
 *
 * Structural bounds (depth/array/key count) guard against a pathological
 * input, not against a legitimate one - every type this runs over
 * (`SupportPrivateDiagnosticsCause`, layer0 snapshots, process metrics) is
 * flat and small by contract, so these limits are a backstop, never a
 * expected-to-trigger truncation. This is deliberately unlike
 * `sanitizeLogValue`: there is no per-string length cap here, ever - a
 * `deepScrubSupportValue` string leaf can be arbitrarily long (a full stack
 * trace) and stays whole.
 */
export function deepScrubSupportValue<T>(value: T): T {
  return scrubValueAtDepth(value, 0) as T;
}

function scrubValueAtDepth(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrubSupportText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= MAX_DEEP_SCRUB_DEPTH) return value;
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_DEEP_SCRUB_ARRAY_ITEMS)
      .map((entry) => scrubValueAtDepth(entry, depth + 1));
  }
  if (isPlainRecord(value)) {
    const scrubbed: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value).slice(
      0,
      MAX_DEEP_SCRUB_OBJECT_KEYS,
    )) {
      scrubbed[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? "<redacted>"
        : scrubValueAtDepth(entry, depth + 1);
    }
    return scrubbed;
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
