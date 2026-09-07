import {
  redactSensitiveText,
  SENSITIVE_KEY_PATTERN,
} from "@traycer/protocol/utils/text/redaction";

/** It reuses the same detection leaf (`@traycer/protocol/utils/text/redaction`) so detection never drifts between the two call sites, then adds a pass `redactLogText` has never had. */

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

const PATH_COMPONENT_CHAR =
  String.raw`[^\s\/\\"'` + "`" + String.raw`<>|()[\]{},;]`;

const PATH_COMPONENT = String.raw`${PATH_COMPONENT_CHAR}+(?: +[A-Z]${PATH_COMPONENT_CHAR}*)*`;

const WINDOWS_PATH_SEPARATOR = String.raw`[\\/]+`;

const POSIX_ABSOLUTE_PATH_PATTERN = new RegExp(
  // Without the boundary, a root such as `home` can claim only the prefix of
  // `/homework` while the optional component tail matches zero times.
  String.raw`\/(?:${POSIX_PATH_ROOT_NAMES.join("|")})(?!${PATH_COMPONENT_CHAR})(?:\/${PATH_COMPONENT})*`,
  "g",
);

// `+` (not `*`) requires at least one `/component` so a bare trailing `~` never matches.
const TILDE_HOME_PATH_PATTERN = new RegExp(
  String.raw`~(?:\/${PATH_COMPONENT})+`,
  "g",
);

const WINDOWS_ABSOLUTE_PATH_PATTERN = new RegExp(
  String.raw`(?<![A-Za-z0-9])[A-Za-z]:${WINDOWS_PATH_SEPARATOR}(?:${PATH_COMPONENT}(?:${WINDOWS_PATH_SEPARATOR}${PATH_COMPONENT})*)?`,
  "g",
);

// `\\server\share\...` UNC paths.
const UNC_PATH_PATTERN = new RegExp(
  String.raw`\\\\${PATH_COMPONENT}(?:${WINDOWS_PATH_SEPARATOR}${PATH_COMPONENT})*`,
  "g",
);

/** No length cap - callers enforce their own field bounds AFTER calling this, never before, so a byte/char budget always measures the scrubbed text that will actually ship (see. */
export function scrubSupportText(text: string): string {
  const pathPseudonyms = new Map<string, string>();
  return scrubSupportTextWithPseudonyms(text, pathPseudonyms);
}

function scrubSupportTextWithPseudonyms(
  text: string,
  pathPseudonyms: Map<string, string>,
): string {
  return text
    .split("\n")
    .map((line) => scrubLine(line, pathPseudonyms))
    .join("\n");
}

function scrubLine(line: string, pathPseudonyms: Map<string, string>): string {
  return pseudonymizeAbsolutePaths(redactSensitiveText(line), pathPseudonyms);
}

/** Never keeps the basename: a workspace path's most sensitive segment is routinely the project/client directory name, not just the leading username, so partial retention does not. */
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
  // Windows MUST run before UNC (code review, finding #2): a JSON-escaped Windows path doubles every backslash ("C:\\Users\\...", i.e. two literal backslash characters after the drive.
  return text
    .replace(WINDOWS_ABSOLUTE_PATH_PATTERN, replace)
    .replace(UNC_PATH_PATTERN, replace)
    .replace(TILDE_HOME_PATH_PATTERN, replace)
    .replace(POSIX_ABSOLUTE_PATH_PATTERN, replace);
}

const MAX_DEEP_SCRUB_DEPTH = 6;
const MAX_DEEP_SCRUB_ARRAY_ITEMS = 200;
const MAX_DEEP_SCRUB_OBJECT_KEYS = 100;

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
