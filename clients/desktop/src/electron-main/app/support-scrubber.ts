import {
  BASIC_AUTH_PATTERN,
  BEARER_PATTERN,
  QUOTED_SENSITIVE_INLINE_VALUE_PATTERN,
  SENSITIVE_KEY_PATTERN,
  SENSITIVE_QUERY_PARAM_PATTERN,
  TOKEN_SHAPE_PATTERN,
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
// paths, home directories, external volumes - lives under one of these roots
// on a real machine. Code review (ticket 09, finding #2) widened this list
// after `/workspace` and `/Volumes` were found passing through unredacted;
// at this boundary a missed root is a privacy leak, so err on including more
// rather than fewer plausible top-level directories.
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
  "workspace",
  "Volumes",
] as const;

// One character of path-component content: anything except a hard
// terminator (whitespace incl. newlines, quotes, backtick, angle brackets,
// pipe, the bracket/brace/paren punctuation stack traces commonly wrap a
// path in, and field separators comma/semicolon). Slash and backslash are
// EXCLUDED here even though they're not "terminators" in the usual sense -
// they are the explicit separators the surrounding patterns supply between
// components, not component content, so the outer repetition (below) does
// real per-directory-level work instead of one greedy run silently
// consuming several real path levels as if they were "one segment".
const PATH_COMPONENT_CHAR =
  String.raw`[^\s\/\\"'` + "`" + String.raw`<>|()[\]{},;]`;

// One path component, tolerating embedded whitespace runs only when the
// word after each one looks like a name continuation - starts with an
// uppercase letter, as in a macOS full-name home directory
// ("/Users/John Doe/...", "/Users/Mary Jane Watson/..."). This is
// deliberately narrow: code review (finding #2) first caught spaces
// terminating the match early and leaking the path's tail
// (`/Users/John Doe/...` -> `<path-1> Doe/...`); the first fix allowed ANY
// embedded space, which over-corrected into swallowing unbounded trailing
// prose whenever a path had no trailing quote/paren/EOL. Requiring each
// continuation word to be capitalized catches the real multi-word-name case
// (any number of them - a single optional continuation missed "Watson" in
// three-word names, and a single literal space missed runs of 2+ spaces)
// while leaving an ordinary lowercase sentence-continuation word
// ("...x.ts then") outside the match.
const PATH_COMPONENT = String.raw`${PATH_COMPONENT_CHAR}+(?: +[A-Z]${PATH_COMPONENT_CHAR}*)*`;

// Windows/UNC separators can be `\` or `/`; POSIX roots only ever use `/`.
// `+` (one-or-more), not exactly one: a JSON-stringified Windows path doubles
// every backslash ("C:\\Users\\...", i.e. two literal backslash characters
// between each level), and matching exactly one separator left the second
// backslash of each pair unconsumed for a LATER pattern (UNC) to grab
// instead, fragmenting one path into several pseudonyms with a bare
// directory name ("Users") leaking through in between.
const WINDOWS_PATH_SEPARATOR = String.raw`[\\/]+`;

const POSIX_ABSOLUTE_PATH_PATTERN = new RegExp(
  // Without the boundary, a root such as `home` can claim only the prefix of
  // `/homework` while the optional component tail matches zero times.
  String.raw`\/(?:${POSIX_PATH_ROOT_NAMES.join("|")})(?!${PATH_COMPONENT_CHAR})(?:\/${PATH_COMPONENT})*`,
  "g",
);

// `~/...` home-relative paths (code review, finding #2 - passed through
// unredacted entirely before this). Bare `~` with no following `/` is left
// alone: on its own it names "the user's home directory" as a concept, not a
// path to a specific file or project. `+` (not `*`) requires at least one
// `/component` so a bare trailing `~` never matches.
const TILDE_HOME_PATH_PATTERN = new RegExp(
  String.raw`~(?:\/${PATH_COMPONENT})+`,
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
  String.raw`(?<![A-Za-z0-9])[A-Za-z]:${WINDOWS_PATH_SEPARATOR}(?:${PATH_COMPONENT}(?:${WINDOWS_PATH_SEPARATOR}${PATH_COMPONENT})*)?`,
  "g",
);

// `\\server\share\...` UNC paths.
const UNC_PATH_PATTERN = new RegExp(
  String.raw`\\\\${PATH_COMPONENT}(?:${WINDOWS_PATH_SEPARATOR}${PATH_COMPONENT})*`,
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
  return scrubSupportTextWithPseudonyms(text, pathPseudonyms);
}

function scrubSupportTextWithPseudonyms(
  text: string,
  pathPseudonyms: Map<string, string>,
): string {
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
    .replace(BASIC_AUTH_PATTERN, "Basic <redacted>")
    // The quoted-key-tolerant superset (code review, finding #3): matches
    // everything the plain `SENSITIVE_INLINE_VALUE_PATTERN` logger.ts still
    // uses unchanged, plus JSON/YAML-style `"password": "value"` forms whose
    // closing key-quote sits between the word and the separator.
    .replace(QUOTED_SENSITIVE_INLINE_VALUE_PATTERN, "$1<redacted>")
    // Token-shape redaction (code review, finding N2): a bare high-entropy
    // key pasted into free text (user intent, a log line, an error message)
    // has no key/assignment context at all for the patterns above to key
    // off of - this matches the token's own published prefix shape instead.
    .replace(TOKEN_SHAPE_PATTERN, "<redacted>");
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
  // Windows MUST run before UNC (code review, finding #2): a JSON-escaped
  // Windows path doubles every backslash ("C:\\Users\\...", i.e. two literal
  // backslash characters after the drive letter), which is indistinguishable
  // from a genuine UNC prefix to a regex that isn't anchored on what precedes
  // it. Running UNC first let it claim everything from the doubled backslash
  // onward as its own match, leaving the bare drive letter ("C:") behind,
  // unredacted. Windows running first consumes the whole thing starting at
  // the drive letter, so there is nothing left for UNC's pattern to find.
  return text
    .replace(WINDOWS_ABSOLUTE_PATH_PATTERN, replace)
    .replace(UNC_PATH_PATTERN, replace)
    .replace(TILDE_HOME_PATH_PATTERN, replace)
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
  return scrubValueAtDepth(value, 0, new Map<string, string>()) as T;
}

function scrubValueAtDepth(
  value: unknown,
  depth: number,
  pathPseudonyms: Map<string, string>,
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return scrubSupportTextWithPseudonyms(value, pathPseudonyms);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  // Fail closed at the structural bound. Returning a container here would
  // expose every unsanitized string nested below it.
  if (depth >= MAX_DEEP_SCRUB_DEPTH) return "<depth-limit>";
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_DEEP_SCRUB_ARRAY_ITEMS)
      .map((entry) => scrubValueAtDepth(entry, depth + 1, pathPseudonyms));
  }
  if (isPlainRecord(value)) {
    const scrubbed: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value).slice(
      0,
      MAX_DEEP_SCRUB_OBJECT_KEYS,
    )) {
      scrubbed[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? "<redacted>"
        : scrubValueAtDepth(entry, depth + 1, pathPseudonyms);
    }
    return scrubbed;
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
