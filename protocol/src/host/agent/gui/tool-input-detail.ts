/**
 * Expanded-view rendering for a tool call's input. The collapsed header already
 * shows a one-line summary (`deriveToolInputSummary`); this layer decides what -
 * if anything - the EXPAND should add, and in a human-readable shape rather than
 * a raw JSON dump.
 *
 * Hybrid rule (see `resolveToolInputDetail`): when the header already captures
 * the whole call there is nothing more to show, so the segment stays header-only
 * and non-expandable. When the input carries more than the header (extra flags, a
 * truncated value, multiple fields), the expand shows it as a reconstructed
 * command (`$ grep -n …`) for command-like tools or a clean label/value list for
 * everything else - never `JSON.stringify`.
 *
 * Computed once on the host at block-build time (`agent-runtime-accumulator`)
 * and PERSISTED structured (`ToolCallBlock.inputDetail`); the raw harness input
 * is never stored. Displayed fields are persisted in FULL (no length cap) so the
 * expand renders exactly what the GUI shows. The never-displayed bulk carriers
 * (an `Edit`'s `old_string`/`new_string`, a `Write`'s `content`, an `apply_patch`
 * patch) are DROPPED entirely — those tool calls are suppressed in the GUI in
 * favour of the `file_change` diff card, so persisting their inline source is the
 * exact chat-doc bloat this refactor removes.
 */

import type { ToolInputDetail } from "@traycer/protocol/persistence/epic/content-blocks";

// The persisted `inputDetail` shape lives with the block schema (persistence
// layer); re-exported here so callers have a single "tool input display" import.
export type { ToolInputDetail } from "@traycer/protocol/persistence/epic/content-blocks";

// Input keys that carry a whole file body / patch inline (`Edit`/`Write`/
// `MultiEdit`/`NotebookEdit`/`apply_patch`). The GUI suppresses these tool calls
// in favour of the `file_change` diff card (`suppressEditToolCalls`), so their
// content is never displayed — persisting it is the exact chat-doc bloat this
// refactor removes. Dropped entirely rather than length-capped: a capped preview
// is still never shown. Every OTHER field is persisted in full (no length cap) so
// the expand renders exactly what the GUI would show.
const BULK_INPUT_FIELDS = new Set([
  "old_string",
  "new_string",
  "content",
  "edits",
  "patch",
  "patchText",
  "new_source",
]);

function asRecord(input: unknown): Record<string, unknown> | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  return input as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isTrue(value: unknown): boolean {
  return value === true;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

// Escape a value for inclusion inside a double-quoted token: backslashes first
// (so the escapes we add for quotes aren't themselves re-interpreted), then the
// quotes.
function escapeDoubleQuoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// Quote a token for a reconstructed command line only when it isn't already a
// bare shell-safe word, so simple values stay unquoted while paths/queries with
// spaces or specials read correctly.
function quoteArg(value: string): string {
  if (/^[\w./@:=+-]+$/.test(value)) return value;
  return `"${escapeDoubleQuoted(value)}"`;
}

// `-C N`, or `-B N -A N`, from either the flag keys or the spelled-out aliases.
function grepContextArgs(record: Record<string, unknown>): string[] {
  const context = asNumber(record["-C"]) ?? asNumber(record["context"]);
  if (context !== null) return [`-C ${context}`];
  const before = asNumber(record["-B"]) ?? asNumber(record["before"]);
  const after = asNumber(record["-A"]) ?? asNumber(record["after"]);
  return [
    ...(before !== null ? [`-B ${before}`] : []),
    ...(after !== null ? [`-A ${after}`] : []),
  ];
}

// A grep call reconstructed into its CLI form. Recognises Claude's `Grep` shape
// (`pattern`, `-n`/`-i` booleans, `-A`/`-B`/`-C` numbers, `type`, `glob`, `path`)
// and the generic `query`/`search` aliases. Tool-specific params with no real
// flag (e.g. `output_mode`, `head_limit`) are intentionally omitted as noise.
function reconstructGrep(record: Record<string, unknown>): string | null {
  const pattern =
    asString(record["pattern"]) ??
    asString(record["query"]) ??
    asString(record["search"]);
  if (pattern === null) return null;

  const type = asString(record["type"]);
  const glob = asString(record["glob"]);
  const path = asString(record["path"]) ?? asString(record["dir"]);
  const caseInsensitive =
    isTrue(record["-i"]) || isTrue(record["case_insensitive"]);
  const lineNumbers = isTrue(record["-n"]) || isTrue(record["line_numbers"]);

  return [
    "grep",
    ...(caseInsensitive ? ["-i"] : []),
    ...(lineNumbers ? ["-n"] : []),
    ...grepContextArgs(record),
    ...(type !== null ? [`--type ${quoteArg(type)}`] : []),
    ...(glob !== null ? [`--glob ${quoteArg(glob)}`] : []),
    `"${escapeDoubleQuoted(pattern)}"`,
    ...(path !== null ? [quoteArg(path)] : []),
  ].join(" ");
}

function prettifyKey(key: string): string {
  // CLI flags (`-n`, `-C`) read best left exactly as the harness sent them.
  if (key.startsWith("-")) return key;
  const spaced = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  if (spaced.length === 0) return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null) return "null";
  try {
    return JSON.stringify(value);
  } catch {
    // Non-serializable (e.g. circular) - surface a marker rather than the
    // useless "[object Object]" default stringification.
    return "[unserializable]";
  }
}

function humanizeFields(record: Record<string, unknown>): Array<{
  key: string;
  label: string;
  value: string;
}> {
  return Object.entries(record).flatMap(([key, value]) => {
    if (value === undefined || BULK_INPUT_FIELDS.has(key)) return [];
    const text = stringifyValue(value);
    if (text.length === 0) return [];
    return [{ key, label: prettifyKey(key), value: text }];
  });
}

/**
 * Human-readable rendering of a tool's input, or null when there is no usable
 * input. A `command` kind renders as a `$ …` line; a `fields` kind as a
 * label/value list. Never returns raw JSON. Never-displayed bulk fields (file
 * bodies / patches, see {@link BULK_INPUT_FIELDS}) are dropped; every other field
 * is persisted in full.
 */
export function deriveToolInputDetail(
  toolName: string,
  input: unknown,
): ToolInputDetail | null {
  const record = asRecord(input);
  if (record === null) {
    const text = asString(input);
    return text === null
      ? null
      : {
          kind: "fields",
          entries: [{ key: "input", label: "Input", value: text }],
        };
  }

  const metadata = asRecord(record["metadata"]);
  const command =
    asString(record["command"]) ??
    asString(record["cmd"]) ??
    asString(record["script"]) ??
    (metadata === null
      ? null
      : (asString(metadata["command"]) ??
        asString(metadata["cmd"]) ??
        asString(metadata["script"])));
  if (command !== null) return { kind: "command", command };

  const name = toolName.toLowerCase();
  if (name.includes("grep")) {
    const grep = reconstructGrep(record);
    if (grep !== null) return { kind: "command", command: grep };
  }

  const entries = humanizeFields(record);
  if (entries.length === 0) return null;
  return { kind: "fields", entries };
}

/**
 * The detail to show in the EXPAND, applying the hybrid rule against an
 * already-derived detail + summary line: returns null when the header summary
 * already conveys the whole input (so the caller renders a header-only,
 * non-expandable segment), and the detail otherwise.
 *
 * Operates on the PERSISTED `inputDetail`/`inputSummary` (computed on the host)
 * rather than re-deriving from raw input, which is no longer stored.
 */
export function resolveToolInputDetail(
  detail: ToolInputDetail | null,
  headerSummary: string | null,
): ToolInputDetail | null {
  if (detail === null) return null;

  const header = headerSummary === null ? "" : normalize(headerSummary);
  if (detail.kind === "command") {
    return normalize(detail.command) === header ? null : detail;
  }
  if (detail.entries.length === 0) return null;
  if (detail.entries.length === 1) {
    return normalize(detail.entries[0].value) === header ? null : detail;
  }
  return detail;
}
