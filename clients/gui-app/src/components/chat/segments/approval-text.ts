import {
  resolveToolInputDetail,
  type ToolInputDetail,
} from "@traycer/protocol/host/agent/gui/tool-input-detail";

/**
 * What an approval says, with nothing said twice.
 *
 * A harness with nothing else to describe a request by names it by its own
 * input: a Codex shell approval's description is the command, and so is the
 * ACP engine's for a shell call (or the call's one-line summary, for
 * Antigravity's reads, searches and fetches). The card's first line already
 * shows `toolName · inputSummary`, so rendering that description as the
 * headline printed the same command twice. A description that says something
 * else - Claude's model-written "Show working tree status" - is the one thing
 * a headline adds, and it is kept.
 *
 * The same rule as a tool row's expand (`resolveToolInputDetail`): what the
 * header already shows is not shown again.
 */

// Whitespace-insensitive, as `resolveToolInputDetail` compares: a summary is
// the input collapsed onto one line.
function collapse(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

// `deriveToolInputSummary` caps a summary at 80 characters and marks the cut
// with this character.
const SUMMARY_ELLIPSIS = "…";

/** Whether `summary` is `full`, cut short by the summary's length cap. */
function isTruncationOf(summary: string, full: string): boolean {
  const collapsed = collapse(summary);
  if (!collapsed.endsWith(SUMMARY_ELLIPSIS)) return false;
  const kept = collapsed.slice(0, -SUMMARY_ELLIPSIS.length);
  return kept.length > 0 && collapse(full).startsWith(kept);
}

/** The pending card's two text lines. */
export interface ApprovalCardText {
  /**
   * The first line's `· summary`: `null` when there is none, and when the
   * headline IS the input, in full - a long command is shown once, uncut,
   * rather than cut on one line and whole on the next. The complete text is
   * the one kept because it is what the user is approving: the tail a cut
   * hides is exactly where `; rm -rf …` would sit. That is also why the
   * headline must equal the whole input and not merely begin like it: the
   * description comes from the harness or the model, not from the input, and
   * one that shares the input's first 79 characters can still end
   * differently - dropping the summary for it would hide the real tail.
   */
  readonly inputSummary: string | null;
  /** The line under it: `null` when it would only repeat the first line. */
  readonly headline: string | null;
  /**
   * The input panel the card can open: `null` only when one of the two lines
   * shows the whole input VERBATIM. The summary is cut at 80 characters, so
   * without it a long command could only be approved on its first 79. And
   * unlike a tool row's expand, whitespace counts here: the summary and a
   * description can both put a command on one line, and in a shell a newline
   * separates two commands where a space passes an argument, so a line that
   * matches only once collapsed is not the command being approved.
   */
  readonly inputDetail: ToolInputDetail | null;
}

export function approvalCardText(
  toolName: string,
  inputSummary: string | null,
  description: string,
  inputDetail: ToolInputDetail | null,
): ApprovalCardText {
  const lines = approvalCardLines(
    toolName,
    inputSummary,
    description,
    inputDetail,
  );
  const whole = singleDetailText(inputDetail);
  const shownVerbatim =
    whole !== null &&
    (lines.inputSummary === whole || lines.headline === whole);
  const hasInput =
    inputDetail !== null &&
    (inputDetail.kind === "command" || inputDetail.entries.length > 0);
  return {
    inputSummary: lines.inputSummary,
    headline: lines.headline,
    inputDetail: hasInput && !shownVerbatim ? inputDetail : null,
  };
}

function approvalCardLines(
  toolName: string,
  inputSummary: string | null,
  description: string,
  inputDetail: ToolInputDetail | null,
): Omit<ApprovalCardText, "inputDetail"> {
  const headline = collapse(description);
  if (headline.length === 0 || headline === collapse(toolName)) {
    return { inputSummary, headline: null };
  }
  if (inputSummary === null) return { inputSummary, headline: description };
  if (headline === collapse(inputSummary)) {
    return { inputSummary, headline: null };
  }
  const fullInput = singleDetailText(inputDetail);
  if (
    fullInput !== null &&
    headline === collapse(fullInput) &&
    isTruncationOf(inputSummary, fullInput)
  ) {
    return { inputSummary: null, headline: description };
  }
  return { inputSummary, headline: description };
}

/** The resolved row's expanded body, before its decision reason. */
export interface ResolvedApprovalBodyText {
  /** The "Request" line: `null` when the header or the input shows it. */
  readonly request: string | null;
  /** The input panel: `null` when the header summary already shows it all. */
  readonly inputDetail: ToolInputDetail | null;
}

/**
 * The resolved row's header shows `label · inputSummary`, and its body the
 * description and the input. Each is shown once: the input panel follows the
 * tool row's rule against the header, and the description is dropped when it
 * is the label, the summary, or the command the input panel already prints.
 */
export function resolvedApprovalBodyText(
  label: string,
  inputSummary: string | null,
  description: string | null,
  inputDetail: ToolInputDetail | null,
): ResolvedApprovalBodyText {
  const detail = resolveToolInputDetail(inputDetail, inputSummary);
  if (description === null) return { request: null, inputDetail: detail };
  const request = collapse(description);
  const shown = [label, inputSummary, singleDetailText(detail)].flatMap(
    (text) => (text === null ? [] : [collapse(text)]),
  );
  const repeated = request.length === 0 || shown.includes(request);
  return { request: repeated ? null : description, inputDetail: detail };
}

// The one text an input panel prints, when it prints only one: the `$ …`
// line, or a lone field's value.
function singleDetailText(detail: ToolInputDetail | null): string | null {
  if (detail === null) return null;
  if (detail.kind === "command") return detail.command;
  return detail.entries.length === 1
    ? (detail.entries.at(0)?.value ?? null)
    : null;
}
