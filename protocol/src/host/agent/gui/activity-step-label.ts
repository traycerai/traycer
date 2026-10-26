/**
 * The one-line label of an agent's latest step - "Ran bun test", "Read
 * src/app.ts" - as the GUI's activity groups name a tool call or a command,
 * and as a host reports a running bot's step (`bot.subscribe`'s activity).
 * Kept here, shared by both, so the verbs, the tool kinds and the cap cannot
 * drift between the transcript and the bot's live status.
 */

import { isTraycerBrowserReplToolName } from "@traycer/protocol/host/agent/gui/browser-tools";

/** The longest an activity label's detail runs before it is cut. */
const ACTIVITY_LABEL_MAX_LENGTH = 96;
const ACTIVITY_LABEL_ELLIPSIS = "...";

type ActivityToolKind =
  | "explore"
  | "read"
  | "search"
  | "edit"
  | "run"
  | "hook"
  | "browser"
  | "tool";

const READ_TOOL_NAMES = new Set([
  "read",
  "read_file",
  "readfile",
  "view",
  "open_file",
]);

const EXPLORE_TOOL_NAMES = new Set([
  "glob",
  "list",
  "ls",
  "list_files",
  "listfiles",
  "find",
]);

const SEARCH_TOOL_NAMES = new Set([
  "grep",
  "search",
  "rg",
  "web_search",
  "websearch",
  "web_fetch",
  "webfetch",
]);

const EDIT_TOOL_NAMES = new Set([
  "edit",
  "edit_file",
  "editfile",
  "multi_edit",
  "multiedit",
  "write_file",
  "writefile",
  "apply_patch",
]);

const RUN_TOOL_NAMES = new Set(["bash", "shell", "run_command", "command"]);

export function normalizedToolName(toolName: string): string {
  return toolName.toLowerCase().replace(/[\s.-]+/g, "_");
}

export function activityToolKind(toolName: string): ActivityToolKind {
  if (isTraycerBrowserReplToolName(toolName)) return "browser";
  const normalized = normalizedToolName(toolName);
  if (normalized.includes("hook")) return "hook";
  if (READ_TOOL_NAMES.has(normalized)) return "read";
  if (EXPLORE_TOOL_NAMES.has(normalized)) return "explore";
  if (SEARCH_TOOL_NAMES.has(normalized)) return "search";
  if (EDIT_TOOL_NAMES.has(normalized)) return "edit";
  if (RUN_TOOL_NAMES.has(normalized)) return "run";
  return "tool";
}

/**
 * Trimmed, collapsed onto one line and cut at
 * {@link ACTIVITY_LABEL_MAX_LENGTH} with an ellipsis; empty when the value has
 * no non-whitespace characters.
 */
export function activityLabelLine(value: string): string {
  const line = value.trim().replace(/\s+/g, " ");
  if (line.length <= ACTIVITY_LABEL_MAX_LENGTH) return line;
  const cutoff = ACTIVITY_LABEL_MAX_LENGTH - ACTIVITY_LABEL_ELLIPSIS.length;
  return `${line.slice(0, cutoff)}${ACTIVITY_LABEL_ELLIPSIS}`;
}

/** A tool call's label: its kind's verb and its input summary, or its name. */
export function toolCallActivityLabel(
  toolName: string,
  inputSummary: string | null,
): string {
  const detail = activityLabelLine(inputSummary ?? toolName);
  const kind = activityToolKind(toolName);
  switch (kind) {
    case "read":
      return `Read ${detail}`;
    case "explore":
      return `Explored ${detail}`;
    case "search":
      return `Searched ${detail}`;
    case "edit":
      return `Edited ${detail}`;
    case "run":
      return `Ran ${detail}`;
    case "hook":
      return `Ran ${activityLabelLine(toolName)}`;
    case "browser":
      return `Browsed ${detail}`;
    case "tool":
      return `Used ${detail}`;
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      return `Used ${detail}`;
    }
  }
}

export function commandActivityLabel(command: string): string {
  return `Ran ${activityLabelLine(command)}`;
}
