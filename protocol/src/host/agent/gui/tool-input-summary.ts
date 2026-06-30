/**
 * Synthesizes one-line display summaries from a tool's input/params - the
 * "· <arg>" detail shown next to a tool name in an agent segment header AND the
 * argument surfaced in a sub-agent's progress timeline. Kept here (shared by the
 * GUI segment headers and the host harness converters) so the field-extraction
 * can't drift between the activity view and the progress view.
 */

const SUMMARY_MAX = 80;
const ELLIPSIS = "…";

type SummaryFn = (input: unknown) => string | null;

function asRecord(input: unknown): Record<string, unknown> | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  return input as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  // Whitespace-only counts as missing: `trim` would collapse it to "" and the
  // caller would render a dangling "· " suffix instead of omitting the detail.
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Collapse to a single line and cap the length.
function trim(value: string): string {
  const singleLine = value.trim().replace(/\s+/g, " ");
  if (singleLine.length === 0) return "";
  if (singleLine.length <= SUMMARY_MAX) return singleLine;
  const cutoff = Math.max(0, SUMMARY_MAX - ELLIPSIS.length);
  return `${singleLine.slice(0, cutoff)}${ELLIPSIS}`;
}

/**
 * Collapse a raw string to a single capped display line (the same normalization
 * the tool-arg summaries get), or null when it has no visible content. Use this
 * for progress lines built straight from a free-form field like a shell command,
 * so a multiline or very long value can't break the "concise one-line" contract.
 */
export function toSummaryLine(value: string): string | null {
  const singleLine = trim(value);
  return singleLine.length === 0 ? null : singleLine;
}

function summarizeFileRange(record: Record<string, unknown>): string | null {
  const path = asString(record["path"]) ?? asString(record["filePath"]);
  if (path === null) return null;
  const start = asNumber(record["startLine"]) ?? asNumber(record["start"]);
  const end = asNumber(record["endLine"]) ?? asNumber(record["end"]);
  if (start !== null && end !== null) {
    return trim(`${path}:${start}-${end}`);
  }
  if (start !== null) {
    return trim(`${path}:${start}`);
  }
  return trim(path);
}

function summarizeQuery(record: Record<string, unknown>): string | null {
  const query =
    asString(record["query"]) ??
    asString(record["pattern"]) ??
    asString(record["search"]);
  if (query === null) return null;
  const path = asString(record["path"]) ?? asString(record["dir"]);
  if (path !== null) return trim(`${query} in ${path}`);
  return trim(query);
}

function summarizeUrl(record: Record<string, unknown>): string | null {
  const url = asString(record["url"]) ?? asString(record["href"]);
  if (url === null) return null;
  return trim(url);
}

function summarizeCommand(record: Record<string, unknown>): string | null {
  const metadata = asRecord(record["metadata"]);
  const cmd =
    asString(record["command"]) ??
    asString(record["cmd"]) ??
    asString(record["script"]) ??
    (metadata === null
      ? null
      : (asString(metadata["command"]) ??
        asString(metadata["cmd"]) ??
        asString(metadata["script"])));
  if (cmd === null) return null;
  return trim(cmd);
}

function summarizeCommentThreadList(
  record: Record<string, unknown>,
): string | null {
  const artifactPaths = record["artifactPaths"];
  const artifactCount = Array.isArray(artifactPaths)
    ? artifactPaths.filter((value) => typeof value === "string").length
    : null;
  const artifacts =
    artifactCount === null
      ? "all artifacts"
      : artifactCount === 1
        ? "1 artifact"
        : `${artifactCount} artifacts`;
  const status = asString(record["status"]) ?? "all";
  return trim(`${artifacts}, ${status}`);
}

function summarizeCommentThreadStatus(
  record: Record<string, unknown>,
): string | null {
  const updates = record["updates"];
  if (!Array.isArray(updates)) return null;
  let threadCount = 0;
  let status: string | null = null;
  for (const update of updates) {
    if (
      update === null ||
      typeof update !== "object" ||
      Array.isArray(update)
    ) {
      continue;
    }
    const updateRecord = update as Record<string, unknown>;
    const threadIds = updateRecord["threadIds"];
    if (Array.isArray(threadIds)) {
      threadCount += threadIds.filter(
        (value) => typeof value === "string",
      ).length;
    }
    status ??= asString(updateRecord["status"]);
  }
  if (threadCount === 0 || status === null) return null;
  const threads = threadCount === 1 ? "1 thread" : `${threadCount} threads`;
  return trim(`${threads} -> ${status}`);
}

const TOOL_REGISTRY: Record<string, SummaryFn> = {
  read_file: (input) => {
    const r = asRecord(input);
    return r === null ? null : summarizeFileRange(r);
  },
  write_file: (input) => {
    const r = asRecord(input);
    return r === null ? null : summarizeFileRange(r);
  },
  edit_file: (input) => {
    const r = asRecord(input);
    return r === null ? null : summarizeFileRange(r);
  },
  list_files: (input) => {
    const r = asRecord(input);
    if (r === null) return null;
    const path = asString(r["path"]) ?? asString(r["dir"]);
    return path === null ? null : trim(path);
  },
  glob: (input) => {
    const r = asRecord(input);
    if (r === null) return null;
    const pattern = asString(r["pattern"]);
    return pattern === null ? null : trim(pattern);
  },
  grep: (input) => {
    const r = asRecord(input);
    return r === null ? null : summarizeQuery(r);
  },
  bash: (input) => {
    const r = asRecord(input);
    return r === null ? null : summarizeCommand(r);
  },
  run_command: (input) => {
    const r = asRecord(input);
    return r === null ? null : summarizeCommand(r);
  },
  web_fetch: (input) => {
    const r = asRecord(input);
    return r === null ? null : summarizeUrl(r);
  },
  web_search: (input) => {
    const r = asRecord(input);
    return r === null ? null : summarizeQuery(r);
  },
  traycer_list_comment_threads: (input) => {
    const r = asRecord(input);
    return r === null ? null : summarizeCommentThreadList(r);
  },
  traycer_set_comment_thread_status: (input) => {
    const r = asRecord(input);
    return r === null ? null : summarizeCommentThreadStatus(r);
  },
};

const GENERIC_PRIORITY_KEYS = [
  "path",
  "filePath",
  "file",
  "url",
  "command",
  "cmd",
  "query",
  "pattern",
  "name",
  "title",
  "description",
];

function genericSummary(input: unknown): string | null {
  const record = asRecord(input);
  if (record === null) {
    if (typeof input === "string" && input.trim().length > 0) {
      return trim(input);
    }
    return null;
  }
  for (const key of GENERIC_PRIORITY_KEYS) {
    const value = asString(record[key]);
    if (value !== null) return trim(value);
  }
  for (const value of Object.values(record)) {
    const stringValue = asString(value);
    if (stringValue !== null) return trim(stringValue);
  }
  return null;
}

/**
 * Synthesize a one-line input summary for a tool. Falls back to the generic
 * first-string-field strategy when the tool is not in the registry. Returns
 * null when no usable string can be derived.
 */
export function deriveToolInputSummary(
  toolName: string,
  input: unknown,
): string | null {
  if (Object.hasOwn(TOOL_REGISTRY, toolName)) {
    const summary = TOOL_REGISTRY[toolName](input);
    if (summary !== null) return summary;
  }
  return genericSummary(input);
}
