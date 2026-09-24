/**
 * Synthesizes one-line display summaries from a tool's input/params - the
 * "· <arg>" detail shown next to a tool name in an agent segment header AND the
 * argument surfaced in a sub-agent's progress timeline. Kept here (shared by the
 * GUI segment headers and the host harness converters) so the field-extraction
 * can't drift between the activity view and the progress view.
 */

import { quoteArg } from "@traycer/protocol/host/agent/gui/tool-input-detail";

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

// Collapse to a single line and cap the length. The cap counts UTF-16 units, so
// a cut landing just after a high surrogate moves one unit earlier: otherwise
// the summary would end in half a pair, which is not well-formed text for
// the card, the headers or the recent-decisions log that persist it.
function trim(value: string): string {
  const singleLine = value.trim().replace(/\s+/g, " ");
  if (singleLine.length === 0) return "";
  if (singleLine.length <= SUMMARY_MAX) return singleLine;
  let cutoff = Math.max(0, SUMMARY_MAX - ELLIPSIS.length);
  const lastKept = singleLine.charCodeAt(cutoff - 1);
  if (lastKept >= 0xd800 && lastKept <= 0xdbff) cutoff -= 1;
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

// The two comment-thread summarizers below outlive their tools on purpose.
// `traycer_list_comment_threads` / `traycer_set_comment_thread_status` were
// removed from the agent surface when artifact comment threads became files
// (`.comments/<threadId>.md`), so no NEW call can reach either entry - but
// transcripts recorded while the tools existed still hold those tool calls,
// and `chat-storage-shape-migration.ts` re-derives a block's `inputSummary`
// from its raw persisted input when it converts an old-shape chat. Dropping
// the entries would silently degrade those rows to the generic fallback,
// which yields `null` for a `{updates: [...]}` payload - a historical call
// rendered with no detail at all. Keep them; they are display-only and cost
// nothing at runtime.
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

function summarizeArtifact(record: Record<string, unknown>): string | null {
  const title = asString(record["title"]);
  if (title !== null) return trim(title);

  const filePaths = record["file_paths"];
  const firstFilePath =
    asString(record["file_path"]) ??
    (Array.isArray(filePaths) ? asString(filePaths[0]) : null);
  if (firstFilePath !== null) {
    const fileName = firstFilePath.split(/[\\/]/).filter(Boolean).at(-1);
    if (fileName !== undefined) return trim(fileName);
  }

  const action = asString(record["action"]);
  if (action === "list") return "Lists artifacts";
  if (action === "list_types") return "Lists artifact types";
  return null;
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
  CronCreate: (input) => {
    const r = asRecord(input);
    if (r === null) return null;
    const cron = asString(r["cron"]);
    const prompt = asString(r["prompt"]);
    if (cron !== null && prompt !== null) return trim(`${cron} · ${prompt}`);
    if (cron !== null) return trim(cron);
    return prompt === null ? null : trim(prompt);
  },
  CronList: () => "Lists scheduled tasks",
  CronDelete: (input) => {
    const r = asRecord(input);
    const id = r === null ? null : asString(r["id"]);
    return id === null
      ? "Deletes a scheduled task"
      : trim(`Deletes scheduled task ${id}`);
  },
  EnterWorktree: (input) => {
    const r = asRecord(input);
    if (r === null) return "Enters a worktree";
    const path = asString(r["path"]);
    if (path !== null) return trim(path);
    const name = asString(r["name"]);
    return name === null ? "Enters a worktree" : trim(name);
  },
  ExitWorktree: (input) => {
    const r = asRecord(input);
    const action = r === null ? null : asString(r["action"]);
    if (action === "keep") return "Keeps the worktree";
    if (action === "remove") return "Removes the worktree";
    return null;
  },
  EnterPlanMode: () => "Enters plan mode",
  TaskGet: (input) => {
    const r = asRecord(input);
    const taskId = r === null ? null : asString(r["taskId"]);
    return taskId === null ? "Reads a task" : trim(`Reads task ${taskId}`);
  },
  ReportFindings: (input) => {
    const r = asRecord(input);
    const findings = r === null ? null : r["findings"];
    if (!Array.isArray(findings)) return null;
    const count = findings.length;
    return `${count} ${count === 1 ? "finding" : "findings"}`;
  },
  Artifact: (input) => {
    const r = asRecord(input);
    return r === null ? null : summarizeArtifact(r);
  },
  PushNotification: (input) => {
    const r = asRecord(input);
    const message = r === null ? null : asString(r["message"]);
    return message === null ? null : trim(message);
  },
  RemoteTrigger: (input) => {
    const r = asRecord(input);
    if (r === null) return null;
    const action = asString(r["action"]);
    if (action === null) return null;
    const triggerId = asString(r["trigger_id"]);
    return trim(
      triggerId === null ? `${action} trigger` : `${action} trigger ${triggerId}`,
    );
  },
  SendFeedback: (input) => {
    const r = asRecord(input);
    const title = r === null ? null : asString(r["title"]);
    return title === null ? null : trim(title);
  },
  ProposeGoal: (input) => {
    const r = asRecord(input);
    const condition = r === null ? null : asString(r["condition"]);
    return condition === null ? null : trim(condition);
  },
  ReadNotifications: () => "Reads notifications",
  SubagentHandback: (input) => {
    const r = asRecord(input);
    const message = r === null ? null : asString(r["message"]);
    return message === null
      ? "Hands a report back to the caller"
      : trim(`Hands a report back to the caller: ${message}`);
  },
};

// Claude uses these exact built-in names for tools whose existing registry
// entries use different spellings. Never match a suffix of an MCP name.
const TOOL_ALIASES: Record<string, string> = {
  Read: "read_file",
  Write: "write_file",
  Edit: "edit_file",
  Glob: "glob",
  Grep: "grep",
  Bash: "bash",
  WebFetch: "web_fetch",
  WebSearch: "web_search",
};

// Most to least telling, first hit wins. See `deriveToolInputSummary`.
const GENERIC_PRIORITY_KEYS = [
  "path",
  "filePath",
  "file_path",
  "absolute_path",
  "notebook_path",
  "file",
  "directory",
  "url",
  "command",
  "cmd",
  "argv",
  "script",
  "query",
  "pattern",
  "name",
  "title",
  "description",
  "cwd",
] as const;

// The ranked keys whose value may be an argv array rather than a string.
const COMMAND_KEYS: ReadonlySet<string> = new Set([
  "command",
  "cmd",
  "argv",
  "script",
]);

// Keys that only ever name a row, never describe the call.
const ID_KEYS: ReadonlySet<string> = new Set([
  "threadid",
  "conversationid",
  "callid",
  "toolcallid",
  "id",
  "sessionid",
]);

// The named ids in any case, plus any other camelCase `...Id` or snake_case
// `..._id` key: Codex's app-server params open with `threadId`, `turnId`,
// `itemId`, so skipping only the first would surface the second.
function isIdKey(key: string): boolean {
  return (
    ID_KEYS.has(key.toLowerCase()) ||
    /[a-z0-9]I[dD]$/.test(key) ||
    /_id$/i.test(key)
  );
}

// Argv elements are literal, so `quoteArg` double-quotes any element that is not
// a bare shell-safe word: `bash -lc "git push --force"` keeps its boundaries,
// and a literal `|` or `>` cannot read as a pipe or a redirect.
function asArgvLine(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const elements = value.filter(
    (element): element is string => typeof element === "string",
  );
  if (elements.length !== value.length) return null;
  if (!elements.some((element) => element.trim().length > 0)) return null;
  return elements.map(quoteArg).join(" ");
}

function rankedValue(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return asString(value) ?? (COMMAND_KEYS.has(key) ? asArgvLine(value) : null);
}

function genericSummary(input: unknown): string | null {
  const record = asRecord(input);
  if (record === null) {
    if (typeof input === "string" && input.trim().length > 0) {
      return trim(input);
    }
    return null;
  }
  for (const key of GENERIC_PRIORITY_KEYS) {
    const value = rankedValue(record, key);
    if (value !== null) return trim(value);
  }
  for (const [key, value] of Object.entries(record)) {
    if (isIdKey(key)) continue;
    const stringValue = asString(value);
    if (stringValue !== null) return trim(stringValue);
  }
  return null;
}

/**
 * Synthesize a one-line input summary for a tool. A tool in the registry uses
 * its own summarizer; anything else, or a registry miss, takes the generic
 * pass below. Returns null when no usable string can be derived.
 *
 * Exact registry names win, followed by explicit Claude aliases. Other names
 * (including MCP-prefixed names) take the generic pass. A string input is
 * summarized as itself. A record takes the first ranked key with a
 * non-blank string, in this order:
 *
 * 1. The target file or directory: `path`, `filePath`, `file_path`,
 *    `absolute_path`, `notebook_path`, `file`, `directory`.
 * 2. `url`.
 * 3. The command: `command`, `cmd`, `argv`, `script`. Here, and only here, an
 *    array of strings also counts, joined by spaces, since Codex sends argv.
 * 4. `query`, `pattern`.
 * 5. `name`.
 * 6. `title`, `description`. These are agent-authored, so they win only
 *    when nothing above is present: Claude's `Task` is summarized by its
 *    `description`, which is the accepted case.
 * 7. `cwd`. It is context rather than the call's target, so it is last. Codex
 *    sends it beside `command` on every command approval, and ranking it with
 *    the paths would summarize each one as its working directory.
 *
 * With no ranked hit, the first non-blank string in insertion order wins,
 * skipping id keys (`threadId`, `conversationId`, `callId`, `toolCallId`,
 * `id`, `sessionId` in any case, and any other `...Id` / `..._id`), so a row
 * never summarizes to an identifier.
 */
export function deriveToolInputSummary(
  toolName: string,
  input: unknown,
): string | null {
  const registryName = Object.hasOwn(TOOL_REGISTRY, toolName)
    ? toolName
    : Object.hasOwn(TOOL_ALIASES, toolName)
      ? TOOL_ALIASES[toolName]
      : null;
  if (registryName !== null) {
    const summary = TOOL_REGISTRY[registryName](input);
    if (summary !== null) return summary;
  }
  return genericSummary(input);
}
