import type { JsonContent } from "./registry";
import { isDefaultGithubMentionHost } from "./github-mention-host";

export enum ContextType {
  File = "file",
  Folder = "folder",
  Worktree = "worktree",
  GithubIssue = "github_issue",
  GithubPullRequest = "github_pull_request",
  Attachment = "attachment",
  Phase = "phase",
  ReviewComment = "review_comment",
  Git = "git",
  Epic = "epic",
  Spec = "spec",
  Ticket = "ticket",
  Story = "story",
  Review = "review",
  WorkflowCommand = "workflow_command",
  Chat = "chat",
  /**
   * A referenceable Agent that uses the Terminal interface.
   *
   * Additive sibling of `Chat`, NOT a replacement: `Chat` is a released token
   * carried by persisted mentions and must keep its value. Agent is the durable
   * entity and Chat/Terminal are its interfaces, so both members serialize to
   * the same interface-agnostic `@agent:` reference form for the coding agent -
   * referring to an Agent means the same thing either way (Core Flows, Flow 3).
   */
  TerminalAgent = "terminal-agent",
  /**
   * A plain interactive terminal - a shell a person or an agent is working
   * in, not an Agent. Distinct from `TerminalAgent` for exactly that reason:
   * `TerminalAgent` names an Agent reached through the terminal interface and
   * projects as `@agent:`, while this names the terminal itself, which a
   * coding agent can only READ (`traycer_read_terminal` / `traycer terminal
   * output`) and never talk to.
   */
  Terminal = "terminal",
  /**
   * A browser tab the coding agent can read (title/URL/page contents) but not
   * drive - a reference by identity, not a control surface. Mirrors `Terminal`
   * exactly: display title plus the durable `tabId` the runtime resolves it
   * with, and no `TerminalAgent`-style interface duality since a browser tab
   * is never itself an Agent.
   */
  BrowserTab = "browser-tab",
  Execution = "execution",
  User = "user",
}

export interface SerializerOptions {
  mentionFormat: "user" | "llm";
  platform: "POSIX" | "WINDOWS";
  listIndent?: number;
  bulletMarker?: "-" | "*" | "+";
  validationResults?: Map<string, ValidationResult>;
}

export interface ValidationResult {
  exists: boolean;
  isDeleted?: boolean;
}

interface SerializerContext {
  options: SerializerOptions;
  listDepth: number;
  // The column the current list's item markers start at. A nested list starts
  // at its parent item's content column, which is past an ordered marker's
  // width (`1. ` is three columns), not at `listDepth * listIndent`.
  listColumn: number;
  orderedListIndex: number;
  inListItem: boolean;
  // True while rendering the content of a GFM table cell: inline text is
  // escaped per text node, mark-aware, so a literal `|` cannot split the cell
  // (see `escapeTableCellText` / `escapeTableCellCode`).
  inTableCell: boolean;
  // True for an artifact body (`jsonContentToArtifactMarkdown`): plain text
  // is escaped wherever the parser would otherwise read markup, so the
  // md -> doc -> md pass every agent write and every projection runs is a
  // fixed point. Prompts, comments and the composer keep the raw text
  // (`jsonContentToMarkdown`), because a model or a person reads those
  // directly and gains nothing from a backslash.
  escapeText: boolean;
}

function createContext(
  options: SerializerOptions,
  escapeText: boolean,
): SerializerContext {
  return {
    options: {
      listIndent: 2,
      bulletMarker: "-",
      ...options,
    },
    listDepth: 0,
    listColumn: 0,
    orderedListIndex: 0,
    inListItem: false,
    inTableCell: false,
    escapeText,
  };
}

function getIndent(ctx: SerializerContext): string {
  return " ".repeat(ctx.listDepth * (ctx.options.listIndent ?? 2));
}

export function escapeXmlAttr(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeXmlContent(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface RenderableMark {
  key: string;
  type: string;
  open: string;
  close: string;
}

function markDelimiters(mark: {
  type: string;
  attrs?: Record<string, unknown>;
}): { open: string; close: string } | null {
  switch (mark.type) {
    case "bold":
      return { open: "**", close: "**" };
    case "italic":
      return { open: "*", close: "*" };
    case "code":
      return { open: "`", close: "`" };
    case "strike":
      return { open: "~~", close: "~~" };
    case "autolink": {
      const href = mark.attrs?.href;
      if (typeof href === "string" && href.length > 0) {
        return { open: "<", close: ">" };
      }
      return null;
    }
    case "link": {
      const href = mark.attrs?.href;
      if (typeof href === "string" && href.length > 0) {
        return { open: "[", close: `](${href})` };
      }
      return null;
    }
    default:
      return null;
  }
}

// Maps a node's marks to the delimiters the serializer can render, keeping
// the stored order except `code`, which is forced innermost: markdown
// renders formatting delimiters inside inline code literally, so the
// backticks must hug the text.
function renderableMarks(
  marks: JsonContent["marks"] | undefined,
): RenderableMark[] {
  if (!marks || marks.length === 0) return [];
  const rendered = marks.flatMap((mark) => {
    const delimiters = markDelimiters(mark);
    if (!delimiters) return [];
    return [
      {
        key: `${mark.type}:${JSON.stringify(mark.attrs ?? {})}`,
        type: mark.type,
        ...delimiters,
      },
    ];
  });
  return [
    ...rendered.filter((mark) => mark.type !== "code"),
    ...rendered.filter((mark) => mark.type === "code"),
  ];
}

interface TextRunEscaping {
  text: (text: string, marks: RenderableMark[]) => string;
  // Applied to every mark delimiter. The only delimiter carrying variable
  // content is a link's `](href)`; the fixed ones (`**`, `` ` ``, `~~`, `[`)
  // contain nothing a cell escape touches, so this is a no-op for them.
  delimiter: (delimiter: string) => string;
}

const noEscaping: TextRunEscaping = {
  text: (text) => text,
  delimiter: (delimiter) => delimiter,
};

// GFM table cells escape a literal `|` as `\|`. The parser (marked's
// `splitCells`) decides whether a pipe is escaped by the PARITY of the
// backslashes in front of it, then strips exactly one backslash from each
// `\|`. Outside inline code that is the ordinary CommonMark escape: doubling
// every backslash keeps a literal `\` literal and guarantees the `\|` we add
// is read as escaped even after a trailing `\`.
function escapeTableCellText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

// Inside inline code CommonMark processes no escapes, so a doubled backslash
// comes back doubled and doubles AGAIN on the next md → doc → md pass. Every
// agent write to an artifact is such a pass; three regex backslashes in one
// table row grew to 3 × 2^21 characters in ~40 appends and blocked the host's
// event loop inside the markdown lexer for good. Code text therefore keeps
// its backslashes and escapes only the pipe. When the pipe follows an ODD run
// of backslashes one more is added so the parity still reads "escaped" and
// the cell cannot split: GFM has no encoding for a literal `\|` inside code,
// so that one case is lossy by design, but it converges after a single pass
// instead of growing (pinned by `json-content-serializer-tables.test.ts`).
function escapeTableCellCode(text: string): string {
  return text.replace(
    /\|/g,
    (_pipe: string, offset: number, source: string): string => {
      let run = 0;
      for (let i = offset - 1; i >= 0 && source[i] === "\\"; i--) run++;
      return run % 2 === 1 ? "\\\\|" : "\\|";
    },
  );
}

const tableCellEscaping: TextRunEscaping = {
  text: (text, marks) =>
    marks.some((mark) => mark.type === "code")
      ? escapeTableCellCode(text)
      : escapeTableCellText(text),
  // A link destination is parsed with CommonMark escapes (and marked strips
  // the `\|`), so the plain-text escape round-trips it exactly as the whole
  // cell used to.
  delimiter: escapeTableCellText,
};

// ASCII punctuation: the characters a CommonMark backslash can escape.
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;
const HTML_OR_AUTOLINK_START = /[A-Za-z/!?]/;
const ENTITY_REFERENCE =
  /^&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]*);/;

/**
 * Escapes artifact text so the parser reads it back as the same text.
 *
 * The parser drops the backslash of every CommonMark escape, so a text node
 * can hold a literal `*`, `_`, `[`, `` ` ``, `~`, `<` or `&amp;` that came from
 * an escaped source. Written back raw it re-parses as emphasis, a link, code,
 * strikethrough, HTML or an entity: the content changes on the next pass.
 * Each character is escaped only where it can form markup:
 *
 * - `\` before ASCII punctuation or a newline, or last in its segment (where
 *   a mark delimiter or a line end follows it and it would escape that
 *   instead, or turn the line end into a hard break);
 * - `*`, `` ` `` and `~` always (emphasis, code, strikethrough);
 * - `_` unless it sits between two word characters, where it cannot open or
 *   close emphasis, so `foo_bar_baz` stays as written;
 * - `[` always, and `]` inside link text, where it would close the text;
 * - `<` only before what opens HTML or an autolink;
 * - `&` only before a complete entity reference;
 * - `|` inside a table cell, where it would end the cell. The `\` rule above
 *   already doubles a backslash in front of it, so the parser's pipe-parity
 *   check reads the added `\|` as escaped.
 */
function escapeArtifactText(
  text: string,
  inLink: boolean,
  inTableCell: boolean,
): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    out += escapesArtifactChar(text, i, inLink, inTableCell)
      ? `\\${char}`
      : char;
  }
  return out;
}

// Characters that can open markup wherever they stand.
const ALWAYS_ESCAPED_ARTIFACT_CHARS: ReadonlySet<string> = new Set([
  "*",
  "`",
  "~",
  "[",
]);

// Lookups rather than a `switch`: the composer's recovery classification
// guard reads every `case "..."` label in this file as a node or mark kind.
function escapesArtifactChar(
  text: string,
  i: number,
  inLink: boolean,
  inTableCell: boolean,
): boolean {
  const char = text[i];
  const next = text[i + 1];
  if (ALWAYS_ESCAPED_ARTIFACT_CHARS.has(char)) return true;
  if (char === "\\") {
    // Before a newline a lone backslash is CommonMark's hard break.
    return next === undefined || next === "\n" || ASCII_PUNCTUATION.test(next);
  }
  if (char === "]") return inLink;
  if (char === "|") return inTableCell;
  if (char === "_") {
    const previous = text[i - 1];
    return !(
      previous !== undefined &&
      next !== undefined &&
      WORD_CHARACTER.test(previous) &&
      WORD_CHARACTER.test(next)
    );
  }
  if (char === "<") {
    return next !== undefined && HTML_OR_AUTOLINK_START.test(next);
  }
  if (char === "&") return ENTITY_REFERENCE.test(text.slice(i));
  return false;
}

const artifactTextEscaping: TextRunEscaping = {
  text: (text, marks) =>
    marks.some((mark) => mark.type === "code" || mark.type === "autolink")
      ? text
      : escapeArtifactText(
          text,
          marks.some((mark) => mark.type === "link"),
          false,
        ),
  delimiter: (delimiter) => delimiter,
};

// A table cell in artifact Markdown is parsed back like any other inline text,
// so it needs the artifact escapes too: a literal `*x*` written raw comes back
// italic. Composed with the cell's own pipe rule rather than layered on top -
// doubling every backslash, as `escapeTableCellText` does, would turn each
// artifact escape into a literal backslash. Code and autolink text process no
// escapes, so both keep `escapeTableCellCode`'s pipe-only rule.
const artifactTableCellEscaping: TextRunEscaping = {
  text: (text, marks) =>
    marks.some((mark) => mark.type === "code" || mark.type === "autolink")
      ? escapeTableCellCode(text)
      : escapeArtifactText(
          text,
          marks.some((mark) => mark.type === "link"),
          true,
        ),
  delimiter: escapeTableCellText,
};

/**
 * Escapes what would open a block at the start of a paragraph line.
 *
 * Inline escaping already covers `*`, `` ` ``, `~`, `[`, `<` and `_`, so a
 * fence, an HTML block, a `*` bullet, a `***` or `___` break and a task
 * checkbox cannot open here. What is left is `#` (ATX heading), `-` and `+`
 * (bullet item, `---` break, setext underline), `>` (block quote), an
 * ordered marker and, on a line after the first, a `===` setext underline or
 * a GFM table delimiter row. The first line of a list item's paragraph sits
 * after the item marker, and `- # x` would read as a heading inside the item,
 * so the same rules apply there. A line start inside an inline code span is
 * left alone: code text is literal.
 */
function escapeParagraphLineStarts(paragraph: string): string {
  // Up to three leading spaces read back as the paragraph's own text, and the
  // marker behind them is escaped below. Four or more (or a tab) would make
  // the line an indented code block instead, so that whitespace is dropped.
  const rendered = /^(?: {4}| {0,3}\t)/.test(paragraph)
    ? paragraph.replace(/^[ \t]+/, "")
    : paragraph;
  let out = "";
  let codeRun = 0;
  let insertAt = -1;
  for (let i = 0; i < rendered.length;) {
    if ((i === 0 || rendered[i - 1] === "\n") && codeRun === 0) {
      const newline = rendered.indexOf("\n", i);
      const line = rendered.slice(
        i,
        newline === -1 ? rendered.length : newline,
      );
      const offset = lineStartEscapeOffset(line, i === 0);
      insertAt = offset === -1 ? -1 : i + offset;
    }
    if (i === insertAt) {
      out += "\\";
      insertAt = -1;
    }
    const char = rendered[i];
    if (char === "\\" && codeRun === 0) {
      out += rendered.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (char === "`") {
      let run = 0;
      while (rendered[i + run] === "`") run++;
      if (codeRun === 0) codeRun = run;
      else if (run === codeRun) codeRun = 0;
      out += rendered.slice(i, i + run);
      i += run;
      continue;
    }
    out += char;
    i++;
  }
  return out;
}

const ATX_HEADING_START = /^#{1,6}(?=[ \t]|$)/;
const BULLET_START = /^[-+](?=[ \t]|$)/;
const DASH_BREAK_OR_UNDERLINE = /^-(?:[ \t]*-)*[ \t]*$/;
const EQUALS_UNDERLINE = /^=+[ \t]*$/;
const ORDERED_START = /^([0-9]{1,9})([.)])(?=[ \t]|$)/;
const TABLE_DELIMITER_ROW =
  /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

// Where a backslash goes so `line` cannot open a block, or -1. The line is
// the whole paragraph line; the inserted backslash always precedes any code
// span on it, because every rule reads only the line's opening characters.
function lineStartEscapeOffset(line: string, firstLine: boolean): number {
  // Block syntax may sit behind up to three spaces, so the escape goes in
  // front of the marker, not in front of the line.
  const indent = (/^ {0,3}/.exec(line)?.[0] ?? "").length;
  const rest = line.slice(indent);
  if (
    ATX_HEADING_START.test(rest) ||
    BULLET_START.test(rest) ||
    DASH_BREAK_OR_UNDERLINE.test(rest) ||
    rest.startsWith(">")
  ) {
    return indent;
  }
  const ordered = ORDERED_START.exec(rest);
  // Only a list starting at 1 can interrupt a paragraph, so a later line
  // needs the escape only for that one.
  if (ordered !== null && (firstLine || ordered[1] === "1")) {
    return indent + ordered[1].length;
  }
  if (!firstLine && EQUALS_UNDERLINE.test(rest)) return indent;
  if (!firstLine && rest.includes("|") && TABLE_DELIMITER_ROW.test(rest)) {
    return indent + rest.indexOf("-");
  }
  return -1;
}

// Node types whose serializer renders its inline content through
// `serializeChildren` and therefore escapes it per text node while
// `inTableCell` is set. Anything else that lands in a cell (mention, image,
// hard break, unknown nodes) is escaped as a rendered whole, exactly as the
// entire cell used to be.
const TABLE_CELL_CONTAINER_TYPES: ReadonlySet<string> = new Set([
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "listItem",
  "taskList",
  "taskItem",
  "table",
]);

/**
 * Exported for the composer's recovery seam, which quotes a dead send's text
 * back to its author and is held to PARITY with this serializer: the marks a
 * resend would carry have to be the marks the recovery copy shows. It reuses
 * this rather than imitating it because the run discipline below is the
 * subtle part, and a second implementation would drift from it silently.
 *
 * Serializes a run of consecutive inline text nodes, emitting mark
 * delimiters only where the mark set changes between nodes. Wrapping each
 * node independently corrupts continuous marks that contain nested marks:
 * `**bold `code` bold**` splits into three text nodes and would serialize
 * as `**bold **` + `` **`code`** `` + `** bold**`, whose doubled `****`
 * runs re-parse as literal asterisks.
 *
 * A mark stays open across a boundary when it is still present in the next
 * node's mark set, regardless of its position there: ProseMirror stores
 * marks sorted by schema rank, so `[italic]` followed by `[bold, italic]`
 * is a continuous italic span gaining bold, not an italic/bold swap.
 *
 * Newly opened marks nest by continuation length - a mark that spans more
 * of the remaining run opens first (outermost). Without this, `_**b** i_`
 * would open bold outside italic (schema-rank order), and bold ending
 * after "b" would force italic closed and reopened, doubling delimiters.
 */
export function serializeTextRun(nodes: JsonContent[]): string {
  return serializeTextRunWith(nodes, noEscaping);
}

interface TextSegment {
  text: string;
  marks: RenderableMark[];
}

function sameMarkKeys(a: RenderableMark[], b: RenderableMark[]): boolean {
  if (a.length !== b.length) return false;
  const keys = new Set(b.map((mark) => mark.key));
  return a.every((mark) => keys.has(mark.key));
}

// Adjacent text nodes carrying the same renderable marks are one continuous
// span in the output - nothing closes or opens between them under the
// boundary rules in `serializeTextRunWith` - so they are joined here and
// escaped as ONE string. For the plain-text cell escape that changes nothing
// (it is context-free per character), but the inline-code pipe escape reads
// the backslash PARITY in front of the pipe, and a mark that renders nothing
// (a thread anchor) can split one code span between a trailing `\` and a
// leading `|`. Escaped on its own the second node sees no backslash, emits
// `\|`, and the parser reads `a\\|b` as an even run and splits the cell.
function coalesceTextSegments(nodes: JsonContent[]): TextSegment[] {
  const segments: TextSegment[] = [];
  for (const node of nodes) {
    if (!node.text) continue;
    const marks = renderableMarks(node.marks);
    const last = segments[segments.length - 1];
    if (last !== undefined && sameMarkKeys(last.marks, marks)) {
      last.text += node.text;
    } else {
      segments.push({ text: node.text, marks });
    }
  }
  return segments;
}

// `escaping.text` sees each segment's text together with its renderable
// marks, so a table cell can escape plain text and code text differently
// (see `tableCellEscaping`); `escaping.delimiter` sees each mark delimiter.
function serializeTextRunWith(
  nodes: JsonContent[],
  escaping: TextRunEscaping,
): string {
  const segments = coalesceTextSegments(nodes);
  const nodeMarks = segments.map((segment) => segment.marks);

  const continuation = (key: string, start: number): number => {
    let end = start;
    while (
      end < nodeMarks.length &&
      nodeMarks[end].some((mark) => mark.key === key)
    ) {
      end++;
    }
    return end - start;
  };

  let out = "";
  let open: RenderableMark[] = [];

  const closeDownTo = (depth: number): void => {
    for (let i = open.length - 1; i >= depth; i--) {
      out += escaping.delimiter(open[i].close);
    }
    open = open.slice(0, depth);
  };

  segments.forEach((segment, index) => {
    const marks = nodeMarks[index];
    const nextKeys = new Set(marks.map((mark) => mark.key));

    let keep = 0;
    while (keep < open.length && nextKeys.has(open[keep].key)) {
      keep++;
    }
    // Inline code renders nested delimiters literally, so nothing may open
    // inside a kept code mark - close it and reopen it innermost instead.
    // A kept code mark is always at the top of the stack (code sorts last).
    const keptKeys = new Set(open.slice(0, keep).map((mark) => mark.key));
    const hasNewMarks = marks.some((mark) => !keptKeys.has(mark.key));
    if (hasNewMarks && keep > 0 && open[keep - 1].type === "code") {
      keep--;
      keptKeys.delete(open[keep].key);
    }

    closeDownTo(keep);

    const toOpen = marks
      .filter((mark) => !keptKeys.has(mark.key))
      .sort((a, b) => continuation(b.key, index) - continuation(a.key, index));
    const ordered = [
      ...toOpen.filter((mark) => mark.type !== "code"),
      ...toOpen.filter((mark) => mark.type === "code"),
    ];
    for (const mark of ordered) {
      out += escaping.delimiter(mark.open);
      open.push(mark);
    }
    out += escaping.text(segment.text, marks);
  });

  closeDownTo(0);
  return out;
}

function getValidationMarker(nodeId: string, ctx: SerializerContext): string {
  const validation = ctx.options.validationResults?.get(nodeId);
  if (!validation) return "";
  if (!validation.exists) return " [NOT FOUND]";
  if (validation.isDeleted) return " [DELETED]";
  return "";
}

export interface MentionAttrs {
  contextType: string;
  id?: string;
  label?: string;
  relPath?: string;
  worktreePath?: string;
  epicId?: string;
  organizationLogin?: string;
  repositoryName?: string;
  issueNumber?: number;
  githubHost?: string;
  branchName?: string;
  commitHash?: string;
  gitType?: string;
  fileName?: string;
  phaseId?: string;
  reviewCommentId?: string;
  terminalId?: string;
  tabId?: string;
  commandName?: string;
  workflowId?: string;
  b64content?: string;
  url?: string;
}

export function formatMentionForDisplayQuery(attrs: MentionAttrs): string {
  if (!attrs) return "";

  switch (attrs.contextType) {
    case ContextType.File:
    case ContextType.Folder:
      return attrs.relPath || attrs.id || "";
    case ContextType.Worktree:
      return attrs.worktreePath || attrs.label || attrs.id || "";
    case ContextType.Spec: {
      const title = attrs.label || attrs.id || "";
      return `spec:${title}`;
    }
    case ContextType.Ticket: {
      const title = attrs.label || attrs.id || "";
      return `ticket:${title}`;
    }
    case ContextType.Story: {
      const title = attrs.label || attrs.id || "";
      return `story:${title}`;
    }
    case ContextType.Review: {
      const title = attrs.label || attrs.id || "";
      return `review:${title}`;
    }
    case ContextType.Epic: {
      const title = attrs.label || attrs.id || "";
      return `epic:${title}`;
    }
    case ContextType.GithubIssue:
    case ContextType.GithubPullRequest: {
      const org = attrs.organizationLogin || "";
      const repo = attrs.repositoryName || "";
      const issue = attrs.issueNumber || "";
      const reference = `${org}/${repo}#${issue}`;
      // Same default-host rule as the LLM form below: github.com is what an
      // unqualified reference already means, while an enterprise reference
      // with the same coordinates is a different thing and must not read
      // identically to the human this string is for.
      if (attrs.githubHost && !isDefaultGithubMentionHost(attrs.githubHost)) {
        return `${attrs.githubHost}/${reference}`;
      }
      return reference;
    }
    case ContextType.Git: {
      const { branchName, commitHash } = attrs;
      if (branchName) return `git:against_branch:${branchName}`;
      if (commitHash) return `git:against_commit:${commitHash}`;
      return "git:against_uncommitted_changes";
    }
    case ContextType.Attachment:
      return `attachment:${attrs.fileName || attrs.label || ""}`;
    case ContextType.Phase:
      return `phase:${attrs.phaseId || attrs.id || ""}`;
    case ContextType.ReviewComment:
      return `review:${attrs.reviewCommentId || attrs.id || ""}`;
    case ContextType.WorkflowCommand: {
      const name = attrs.commandName || attrs.label || "";
      return `workflow:${name}`;
    }
    // Agent is the durable entity a human reads here; Chat and Terminal are
    // only the interfaces used to reach one. Both arms therefore project as
    // `agent:` - prefixing by interface (`chat:` / `terminal-agent:`) would
    // render the two as sibling entity types, which is the model this replaces.
    // The enum values stay `chat` / `terminal-agent`; only the projection moved.
    case ContextType.Chat:
    case ContextType.TerminalAgent: {
      const title = attrs.label || attrs.id || "";
      return `agent:${title}`;
    }
    case ContextType.Terminal: {
      const title = attrs.label || attrs.terminalId || attrs.id || "";
      return `terminal:${title}`;
    }
    case ContextType.BrowserTab: {
      const title = attrs.label || attrs.tabId || attrs.id || "";
      return `browser-tab:${title}`;
    }
    case ContextType.Execution: {
      const title = attrs.label || attrs.id || "";
      return `execution:${title}`;
    }
    case ContextType.User: {
      const name = attrs.label || attrs.id || "";
      return `@${name}`;
    }
    default:
      return attrs.label || attrs.id || "";
  }
}

// Narrow `Record<string, unknown>` mention attrs to the typed mention
// shape at the boundary. The TipTap document schema is open
// (`attrs: Record<string, unknown>`) but mention nodes always carry a
// `MentionAttrs`-shaped payload by upstream validation.
function asMentionAttrs(
  attrs: Record<string, unknown> | undefined,
): Partial<MentionAttrs> {
  return (attrs ?? {}) as Partial<MentionAttrs>;
}

// Reads a string-typed attribute from a JsonContent `attrs` bag. Returns
// the empty string when missing or non-string so atom serializers can omit
// malformed values without special-casing each call site.
function readStringAttr(
  attrs: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = attrs?.[key];
  return typeof value === "string" ? value : "";
}

// Reads a numeric-typed attribute with a default fallback when the
// attribute is absent or not a finite number.
function readNumberAttr(
  attrs: Record<string, unknown> | undefined,
  key: string,
  fallback: number,
): number {
  const value = attrs?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function formatMentionForLLMQuery(
  node: JsonContent,
  ctx: SerializerContext,
): string {
  if (!node.attrs) return "";
  const attrs = asMentionAttrs(node.attrs);

  const marker = getValidationMarker(attrs.id || "", ctx);
  const atRef = (value: string): string =>
    value.length === 0 ? marker.trimStart() : `@${value}${marker}`;

  switch (attrs.contextType) {
    case ContextType.File:
    case ContextType.Folder: {
      return atRef(attrs.relPath || attrs.id || "");
    }
    case ContextType.Worktree: {
      // A worktree lives outside the workspace root, so its absolute
      // directory is the only path that resolves for the agent.
      return atRef(attrs.worktreePath || attrs.id || "");
    }
    case ContextType.Spec: {
      return atRef(requiredArtifactRelPath(attrs));
    }
    case ContextType.Ticket: {
      return atRef(requiredArtifactRelPath(attrs));
    }
    case ContextType.Story: {
      return atRef(requiredArtifactRelPath(attrs));
    }
    case ContextType.Review: {
      return atRef(requiredArtifactRelPath(attrs));
    }
    case ContextType.Epic:
      return atRef(attrs.relPath || `epic:${attrs.epicId || attrs.id || ""}`);
    case ContextType.GithubIssue:
    case ContextType.GithubPullRequest: {
      const org = attrs.organizationLogin || "";
      const repo = attrs.repositoryName || "";
      const issue = attrs.issueNumber || "";
      const prefix =
        attrs.contextType === ContextType.GithubPullRequest
          ? "github-pr"
          : "github-issue";
      const reference = `@${prefix}:${org}/${repo}#${issue}`;
      // `url` is still optional on the node, so the suffix is only appended
      // when there is one. Emitting `[url=]` for a node that predates the
      // attribute - or for any caller that omits it - turns a reference that
      // used to serialize cleanly into malformed metadata, and hands the agent
      // an empty fallback instead of no fallback.
      if (attrs.url) return `${reference} [url=${attrs.url}]`;
      // Without a URL, the host is the only thing that can disambiguate an
      // enterprise reference: `org/repo#123` on ghe.example.com is a different
      // artifact from the same coordinates on github.com, and the node keeps
      // `githubHost` even when no `url` was ever set. github.com stays bare -
      // it is the default every unqualified reference already means, and
      // qualifying it would churn every serialization that was fine.
      if (attrs.githubHost && !isDefaultGithubMentionHost(attrs.githubHost)) {
        return `${reference} [host=${attrs.githubHost}]`;
      }
      return reference;
    }
    case ContextType.Git: {
      if (attrs.branchName)
        return `@git-diff:branch:${attrs.branchName}...HEAD`;
      if (attrs.commitHash)
        return `@git-diff:commit:${attrs.commitHash}...HEAD`;
      return "@git-diff:working-tree";
    }
    case ContextType.Attachment:
      return `attachment:${attrs.fileName || attrs.label || attrs.id || ""}`;
    case ContextType.Phase:
      return `phase:${attrs.phaseId || attrs.id || ""}`;
    case ContextType.ReviewComment:
      return `review:${attrs.reviewCommentId || attrs.id || ""}`;
    case ContextType.WorkflowCommand: {
      // Support both lean attrs (id="wfId/cmdName") and rich attrs (workflowId+commandName)
      if (attrs.id) {
        return `workflow:${attrs.id}`;
      }
      const wfId = attrs.workflowId || "";
      const cmdName = attrs.commandName || "";
      return cmdName ? `workflow:${wfId}/${cmdName}` : `workflow:${wfId}`;
    }
    // Both Agent interfaces share this arm deliberately. "Refer to Agent B"
    // must mean the same thing to the coding agent whether B uses the Chat or
    // the Terminal interface, so both emit the interface-agnostic `@agent:`
    // marker plus the durable id the agent needs for `traycer_send_message` /
    // `traycer_get_transcript`. Falling through to `default:` dropped the id
    // entirely and handed the runtime a bare title.
    case ContextType.Chat:
    case ContextType.TerminalAgent: {
      const agentId = attrs.id || "";
      const title = attrs.label || "untitled";
      return agentId.length === 0
        ? `@agent:${title} [agentId is unavailable]`
        : `@agent:${title} [agentId=${agentId}]`;
    }
    // Mirrors the agent arm above: a human-readable title so the reference
    // reads as the user wrote it, plus the durable id the read tools address
    // (`traycer_read_terminal`, `traycer terminal output`). Without the id the
    // runtime is handed a bare title it cannot resolve.
    case ContextType.Terminal: {
      const terminalId = attrs.terminalId || attrs.id || "";
      const title = attrs.label || "untitled";
      return terminalId.length === 0
        ? `@terminal:${title} [terminalId is unavailable]`
        : `@terminal:${title} [terminalId=${terminalId}]`;
    }
    // Mirrors the terminal arm above exactly: a browser tab is readable but
    // not addressable as an Agent, so it gets the same title+id shape rather
    // than the `@agent:` projection.
    case ContextType.BrowserTab: {
      const tabId = attrs.tabId || attrs.id || "";
      const title = attrs.label || "untitled";
      return tabId.length === 0
        ? `@browser-tab:${title} [tabId is unavailable]`
        : `@browser-tab:${title} [tabId=${tabId}]`;
    }
    case ContextType.Execution: {
      const epicPart = attrs.epicId ? `${attrs.epicId}/` : "";
      return `execution:${epicPart}${attrs.id}${marker}`;
    }
    case ContextType.User: {
      const name = attrs.label || attrs.id || "";
      return `@${name}`;
    }
    default:
      return attrs.label || attrs.id || "";
  }
}

function requiredArtifactRelPath(attrs: Partial<MentionAttrs>): string {
  if (attrs.relPath && attrs.relPath.length > 0) return attrs.relPath;
  throw new Error(
    `Artifact mention is missing resolved path: contextType=${attrs.contextType ?? ""} id=${attrs.id ?? ""}`,
  );
}

function formatMentionForUser(
  node: JsonContent,
  ctx: SerializerContext,
): string {
  if (!node.attrs) return "";
  const attrs = asMentionAttrs(node.attrs);

  const marker = getValidationMarker(attrs.id || "", ctx);

  // For files/folders, prefer relPath over absolute path
  if (
    attrs.contextType === ContextType.File ||
    attrs.contextType === ContextType.Folder
  ) {
    const displayPath = attrs.relPath || attrs.id || "";
    return `\`${displayPath}\`${marker}`;
  }

  if (attrs.contextType === ContextType.Worktree) {
    const displayPath = attrs.worktreePath || attrs.label || attrs.id || "";
    return `\`${displayPath}\`${marker}`;
  }

  if (attrs.contextType === ContextType.User) {
    const name = attrs.label || attrs.id || "";
    return `@${name}`;
  }

  // GitHub references carry their durable URL in the LLM form and are never
  // materialized against this host. Unlike file/artifact references, a stale
  // validation result must not append `[NOT FOUND]` to either kind of chip.
  if (
    attrs.contextType === ContextType.GithubIssue ||
    attrs.contextType === ContextType.GithubPullRequest
  ) {
    const formatted = formatMentionForDisplayQuery({
      ...attrs,
      contextType: attrs.contextType,
    });
    return `\`${formatted}\``;
  }

  // Use shared formatting for all other types. `contextType` is
  // guaranteed by upstream validation; default to empty so the helper
  // falls through to its `default` branch on malformed inputs.
  const formatted = formatMentionForDisplayQuery({
    ...attrs,
    contextType: attrs.contextType ?? "",
  });
  return `\`${formatted}\`${marker}`;
}

function serializeMention(node: JsonContent, ctx: SerializerContext): string {
  if (ctx.options.mentionFormat === "llm") {
    return formatMentionForLLMQuery(node, ctx);
  }
  return formatMentionForUser(node, ctx);
}

function serializeSlashCommand(
  node: JsonContent,
  ctx: SerializerContext,
): string {
  if (ctx.options.mentionFormat === "llm") {
    return "";
  }
  const commandName = readStringAttr(node.attrs, "commandName");
  return `/${commandName}`;
}

function serializeText(node: JsonContent): string {
  if (node.type !== "text" || !node.text) return "";
  return serializeTextRun([node]);
}

// A bare newline is a soft break to the parser: in artifact Markdown, which
// is parsed back, the hard break would come back as a newline inside the
// text. A backslash before the newline is CommonMark's hard break, and reads
// back as one. A table cell keeps the bare newline: it cannot hold a line
// break at all.
function serializeHardBreak(ctx: SerializerContext): string {
  return ctx.escapeText && !ctx.inTableCell ? "\\\n" : "\n";
}

function serializeCodeBlock(node: JsonContent, ctx: SerializerContext): string {
  const language = readStringAttr(node.attrs, "language");
  const indent = getIndent(ctx);
  let code = "";

  if (node.content) {
    code = node.content
      .map((child) => (child.type === "text" ? child.text || "" : ""))
      .join("");
  }

  if (code.endsWith("\n")) {
    code = code.slice(0, -1);
  }

  const lines = code.split("\n");
  const indentedCode = lines.map((line) => `${indent}${line}`).join("\n");

  return `${indent}\`\`\`${language}\n${indentedCode}\n${indent}\`\`\``;
}

function serializeMermaidBlock(
  node: JsonContent,
  ctx: SerializerContext,
): string {
  const indent = getIndent(ctx);
  const code = readStringAttr(node.attrs, "code");
  const lines = code.split("\n");
  const indentedCode = lines.map((line) => `${indent}${line}`).join("\n");
  return `${indent}\`\`\`mermaid\n${indentedCode}\n${indent}\`\`\``;
}

function serializeUIPreviewBlock(
  node: JsonContent,
  ctx: SerializerContext,
): string {
  const indent = getIndent(ctx);
  const htmlContent = readStringAttr(node.attrs, "htmlContent");
  const lines = htmlContent.split("\n");
  const indentedHtml = lines.map((line) => `${indent}${line}`).join("\n");
  return `${indent}\`\`\`wireframe\n${indentedHtml}\n${indent}\`\`\``;
}

function serializeHeading(node: JsonContent, ctx: SerializerContext): string {
  const level = readNumberAttr(node.attrs, "level", 1);
  const prefix = "#".repeat(level);
  const content = serializeChildren(node.content, ctx);
  return `${prefix} ${content}`;
}

// The host keeps an artifact image it cannot resolve yet (a missing file, a
// failed download) as a paragraph holding the image's own Markdown as plain
// text, `![alt](dest)` with `dest` bracketed as `<src>` when the source holds
// whitespace or parentheses (`rawArtifactImageText` in the host's
// epic-file-sync). Written back verbatim, the next read parses it as an image
// again, which is how a later write retries it. Escaped, it would stay text
// for good, so exactly that shape - and nothing looser - is left raw. The alt
// text may hold balanced brackets, as an image's alt can, but no other `]`:
// one would end the alt early, so `![x](a) [y](b)` is an image followed by a
// link, not one image, and stays escaped text.
const UNRESOLVED_IMAGE_SOURCE_TEXT =
  /^!\[(?:[^[\]\n]|\[[^[\]\n]*\])*\]\((?:<[^<>\n]*>|[^\s()<>]*)\)$/;

function unresolvedImageSourceText(node: JsonContent): string | null {
  const only = node.content?.length === 1 ? node.content[0] : undefined;
  if (
    only?.type !== "text" ||
    typeof only.text !== "string" ||
    (only.marks?.length ?? 0) > 0
  ) {
    return null;
  }
  return UNRESOLVED_IMAGE_SOURCE_TEXT.test(only.text) ? only.text : null;
}

function serializeParagraph(node: JsonContent, ctx: SerializerContext): string {
  const indent = ctx.inListItem ? "" : getIndent(ctx);
  const unresolvedImage =
    ctx.escapeText && !ctx.inTableCell ? unresolvedImageSourceText(node) : null;
  if (unresolvedImage !== null) return `${indent}${unresolvedImage}`;
  const children = serializeChildren(node.content, ctx);
  const content =
    ctx.escapeText && !ctx.inTableCell
      ? escapeParagraphLineStarts(children)
      : children;
  return `${indent}${content}`;
}

function serializeBlockquote(node: JsonContent): string {
  const quoteLines: string[] = [];

  if (node.content) {
    for (const child of node.content) {
      quoteLines.push(extractTextFromNode(child));
    }
  }

  const quoted = quoteLines.join("\n");
  const escapedContent = escapeXmlContent(quoted);

  return `<user_quoted_section>${escapedContent}</user_quoted_section>`;
}

// An artifact's quote is written as a markdown block quote, its blocks and
// marks intact, because the artifact is parsed back into the same document.
// The `<user_quoted_section>` form above is a prompt format: it flattens the
// quote to plain text, and re-parsed it is a paragraph of literal tag text,
// so the quote and its formatting were gone after one pass.
function serializeArtifactBlockquote(
  node: JsonContent,
  ctx: SerializerContext,
): string {
  // The quote's own `> ` prefix starts its lines afresh, so a list inside it
  // starts at column zero whatever list the quote itself sits in, and its
  // content is not a task item's even when the quote is inside one.
  const quoteCtx: SerializerContext = {
    ...ctx,
    listDepth: 0,
    listColumn: 0,
    inListItem: false,
  };
  const blocks = (node.content ?? [])
    .map((child) => serializeNode(child, quoteCtx))
    .filter((block) => block.length > 0);
  return blocks
    .join("\n\n")
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
}

function serializeSourcedQuote(node: JsonContent): string {
  const sourceType = readStringAttr(node.attrs, "sourceType");
  const sourceId = readStringAttr(node.attrs, "sourceId");
  const sourceEpicId = readStringAttr(node.attrs, "sourceEpicId");
  const quoteLines: string[] = [];

  if (node.content) {
    for (const child of node.content) {
      quoteLines.push(extractTextFromNode(child));
    }
  }

  const quoted = quoteLines.join("\n");
  const escapedArtifactType = escapeXmlAttr(sourceType);
  const escapedArtifactId = escapeXmlAttr(sourceId);
  const escapedEpicId = escapeXmlAttr(sourceEpicId);
  const escapedContent = escapeXmlContent(quoted);

  return `<quoted_artifact artifact_type="${escapedArtifactType}" artifact_id="${escapedArtifactId}" epic_id="${escapedEpicId}">${escapedContent}</quoted_artifact>`;
}

function extractTextFromNode(node: JsonContent): string {
  let text = "";
  if (node.type === "text" && node.text) {
    text += node.text;
  } else if (node.content) {
    for (const child of node.content) {
      text += extractTextFromNode(child);
    }
  }
  return text;
}

function serializeBulletList(
  node: JsonContent,
  ctx: SerializerContext,
): string {
  const items: string[] = [];
  const childCtx: SerializerContext = {
    ...ctx,
    listDepth: ctx.listDepth + 1,
  };

  if (node.content) {
    for (const child of node.content) {
      if (child.type === "listItem") {
        items.push(serializeListItem(child, childCtx, false, 0));
      }
    }
  }

  return items.join("\n");
}

function serializeOrderedList(
  node: JsonContent,
  ctx: SerializerContext,
): string {
  const items: string[] = [];
  const childCtx: SerializerContext = {
    ...ctx,
    listDepth: ctx.listDepth + 1,
  };

  if (node.content) {
    let index = readNumberAttr(node.attrs, "start", 1);
    for (const child of node.content) {
      if (child.type === "listItem") {
        items.push(serializeListItem(child, childCtx, true, index));
        index++;
      }
    }
  }

  return items.join("\n");
}

function serializeTaskList(node: JsonContent, ctx: SerializerContext): string {
  const items: string[] = [];
  const childCtx: SerializerContext = {
    ...ctx,
    listDepth: ctx.listDepth + 1,
  };

  if (node.content) {
    for (const child of node.content) {
      if (child.type === "taskItem") {
        items.push(serializeTaskItem(child, childCtx));
      }
    }
  }

  return items.join("\n");
}

// `- [ ] ` / `- [x] `, the GFM task list item the artifact parser reads back
// as `taskItem` with `checked`. Continuation lines indent to the bullet's
// content column, not past the checkbox: four more columns would re-parse
// them as an indented code block.
function serializeTaskItem(node: JsonContent, ctx: SerializerContext): string {
  const checked = node.attrs?.checked === true;
  return serializeListItemWithMarker(
    node,
    ctx,
    ctx.options.bulletMarker ?? "-",
    checked ? "[x] " : "[ ] ",
  );
}

function serializeListItem(
  node: JsonContent,
  ctx: SerializerContext,
  ordered: boolean,
  index: number,
): string {
  const marker = ordered ? `${index}.` : (ctx.options.bulletMarker ?? "-");
  return serializeListItemWithMarker(node, ctx, marker, "");
}

const LIST_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "bulletList",
  "orderedList",
  "taskList",
]);

const BARE_BULLET_LINE = /^[ \t]*-[ \t]*$/;

const SELF_INDENTING_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "codeBlock",
  "mermaidBlock",
  "uiPreviewBlock",
]);

function serializeListItemWithMarker(
  node: JsonContent,
  ctx: SerializerContext,
  marker: string,
  checkbox: string,
): string {
  const baseIndent = " ".repeat(ctx.listColumn);

  const lines: string[] = [];
  let firstLine = true;
  let markerOnly = false;

  const itemCtx: SerializerContext = {
    ...ctx,
    inListItem: true,
  };

  const continuationIndent = " ".repeat(baseIndent.length + marker.length + 1);
  // A nested list starts at this item's content column, never short of it:
  // under `1. ` a list at two columns is not inside the item, and a parser
  // that strips the content column from it moves it on every pass.
  const nestedListCtx: SerializerContext = {
    ...itemCtx,
    listColumn:
      baseIndent.length +
      Math.max(ctx.options.listIndent ?? 2, marker.length + 1),
  };

  const markerLine = `${baseIndent}${marker} ${checkbox}`;

  if (node.content) {
    for (const child of node.content) {
      // A fenced block indents itself by list depth; under an item it takes
      // the continuation indent below instead, or every round trip would
      // push it one level deeper.
      const fenced = SELF_INDENTING_BLOCK_TYPES.has(child.type ?? "");
      const isList = LIST_BLOCK_TYPES.has(child.type ?? "");
      const serialized = serializeNode(
        child,
        fenced
          ? { ...itemCtx, listDepth: 0 }
          : isList
            ? nestedListCtx
            : itemCtx,
      );
      const childLines = serialized.split("\n");

      if (firstLine) {
        if (fenced || isList) {
          // A fence or a list as the item's FIRST child starts on the line
          // after an empty marker line: the ordered and task item parsers read
          // an item's first line as a paragraph, so a fence opened on the
          // marker line comes back as text, and a list there comes back as
          // text, a code block or a list split in two. The empty marker line
          // is also exactly what an item whose first paragraph is empty
          // writes, so both shapes read back the same. A nested list already
          // carries the content column.
          lines.push(markerLine);
          for (const line of childLines) {
            lines.push(isList ? line : `${continuationIndent}${line}`);
          }
        } else {
          // Every line after the marker line sits at the content column. A
          // hard break is a bare "\n", and the line after it at column zero
          // is not inside the item: the task item parser reads only the
          // marker line as the item's paragraph, so the rest of it leaves the
          // item.
          const [head, ...rest] = childLines;
          lines.push(`${markerLine}${head}`);
          for (const line of rest) {
            lines.push(`${continuationIndent}${line}`);
          }
          markerOnly = serialized === "";
        }
        firstLine = false;
      } else {
        // A later paragraph is its own paragraph only behind a blank line:
        // directly under the line before, it reads back as that line's
        // continuation, and on the next pass falls out of the item. Behind
        // a marker line with nothing on it the blank line would end the item
        // instead (an item opens with at most one blank line), so there the
        // paragraph follows directly and reads back as the item's own.
        if (child.type === "paragraph" && !markerOnly) lines.push("");
        markerOnly = false;
        // A nested list that opens with an empty bullet item starts with a
        // bare `-` line, and directly under a line of text that reads as a
        // setext heading underline: the item's paragraph would come back as
        // a heading. A blank line before the list keeps it a list.
        if (
          isList &&
          BARE_BULLET_LINE.test(childLines[0] ?? "") &&
          lines.length > 0 &&
          lines[lines.length - 1] !== ""
        ) {
          lines.push("");
        }
        for (const line of childLines) {
          lines.push(isList ? line : `${continuationIndent}${line}`);
        }
      }
    }
  }

  // An item with no children still holds its place: the ordered item parser
  // gives `2. ` with nothing after it no paragraph, and dropping the line
  // would split the list around it.
  if (lines.length === 0) lines.push(`${baseIndent}${marker} ${checkbox}`);

  return lines.join("\n");
}

function serializeTable(node: JsonContent, ctx: SerializerContext): string {
  if (!node.content) return "";

  const rows: string[][] = [];
  let headerRow: string[] | null = null;

  for (const row of node.content) {
    if (row.type !== "tableRow") continue;

    const cells: string[] = [];
    let isHeader = false;

    if (row.content) {
      for (const cell of row.content) {
        if (cell.type === "tableHeader") {
          isHeader = true;
        }
        // Escaping happens per text node under `inTableCell` (mark-aware, see
        // `escapeTableCellRun`) - never on the rendered cell string, which
        // cannot tell code text from plain text.
        cells.push(
          serializeChildren(cell.content, { ...ctx, inTableCell: true }),
        );
      }
    }

    if (isHeader && !headerRow) {
      headerRow = cells;
    } else {
      rows.push(cells);
    }
  }

  const lines: string[] = [];

  if (headerRow) {
    lines.push(`| ${headerRow.join(" | ")} |`);
    lines.push(`| ${headerRow.map(() => "---").join(" | ")} |`);
  }

  for (const row of rows) {
    lines.push(`| ${row.join(" | ")} |`);
  }

  return lines.join("\n");
}

function serializeChildren(
  content: JsonContent[] | undefined,
  ctx: SerializerContext,
): string {
  if (!content) return "";

  // Consecutive text nodes serialize as one run so mark delimiters land only
  // where the mark set actually changes; non-text inline nodes (mention,
  // hardBreak, …) end the run and close any open marks.
  const parts: string[] = [];
  let textRun: JsonContent[] = [];
  const escaping = ctx.inTableCell
    ? ctx.escapeText
      ? artifactTableCellEscaping
      : tableCellEscaping
    : ctx.escapeText
      ? artifactTextEscaping
      : noEscaping;
  const flushTextRun = (): void => {
    if (textRun.length > 0) {
      parts.push(serializeTextRunWith(textRun, escaping));
      textRun = [];
    }
  };

  for (const child of content) {
    if (child.type === "text") {
      textRun.push(ctx.escapeText ? asAutolink(child) : child);
    } else {
      flushTextRun();
      const rendered = serializeNode(child, ctx);
      const escapesItsOwnText =
        child.type !== undefined && TABLE_CELL_CONTAINER_TYPES.has(child.type);
      parts.push(
        ctx.inTableCell && !escapesItsOwnText
          ? escapeTableCellText(rendered)
          : rendered,
      );
    }
  }
  flushTextRun();

  return parts.join("");
}

const AUTOLINK_URI = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*$/;

// A link whose text is its own absolute URL (what an autolinked URL parses
// to) is written back as `<url>`. Autolink content is literal, so the URL
// needs no escapes - `https://x.dev/_a_` as link text would need `\_` to stay
// out of emphasis - and the parser returns the same link.
function asAutolink(node: JsonContent): JsonContent {
  if (node.text === undefined || node.marks === undefined) return node;
  const text = node.text;
  if (node.marks.some((mark) => mark.type === "code")) return node;
  const link = node.marks.find(
    (mark) =>
      mark.type === "link" &&
      mark.attrs?.href === text &&
      AUTOLINK_URI.test(text),
  );
  if (link === undefined) return node;
  return {
    ...node,
    marks: node.marks.map((mark) =>
      mark === link ? { type: "autolink", attrs: link.attrs } : mark,
    ),
  };
}

function serializeImage(node: JsonContent): string {
  const src = readStringAttr(node.attrs, "src");
  const alt = readStringAttr(node.attrs, "alt");
  if (src.length === 0) return "";
  const escapedAlt = alt.replace(/[\\[\]]/g, "\\$&");
  const destination = /[\s()<>]/.test(src)
    ? `<${src.replace(/[<>\\]/g, "\\$&")}>`
    : src;
  return `![${escapedAlt}](${destination})`;
}

function serializeNode(node: JsonContent, ctx: SerializerContext): string {
  switch (node.type) {
    case "doc":
      return serializeDocument(node, ctx);
    case "paragraph":
      return serializeParagraph(node, ctx);
    case "text":
      return serializeText(node);
    case "hardBreak":
      return serializeHardBreak(ctx);
    case "image":
      return serializeImage(node);
    case "heading":
      return serializeHeading(node, ctx);
    case "bulletList":
      return serializeBulletList(node, ctx);
    case "orderedList":
      return serializeOrderedList(node, ctx);
    case "listItem":
      return serializeListItem(node, ctx, false, 0);
    case "taskList":
      return serializeTaskList(node, ctx);
    case "taskItem":
      return serializeTaskItem(node, ctx);
    case "codeBlock":
      return serializeCodeBlock(node, ctx);
    case "mermaidBlock":
      return serializeMermaidBlock(node, ctx);
    case "uiPreviewBlock":
      return serializeUIPreviewBlock(node, ctx);
    case "blockquote":
      return ctx.escapeText
        ? serializeArtifactBlockquote(node, ctx)
        : serializeBlockquote(node);
    case "sourcedQuote":
      return serializeSourcedQuote(node);
    case "table":
      return serializeTable(node, ctx);
    case "mention":
      return serializeMention(node, ctx);
    case "slashCommand":
      return serializeSlashCommand(node, ctx);
    default:
      return extractTextFromNode(node);
  }
}

function serializeDocument(node: JsonContent, ctx: SerializerContext): string {
  if (!node.content) return "";

  const blocks: string[] = [];

  for (const child of node.content) {
    const serialized = serializeNode(child, ctx);
    if (serialized) {
      blocks.push(serialized);
    }
  }

  return blocks.join("\n\n");
}

// An empty task or ordered item keeps the one space after its marker, on the
// last line too. `- [ ]` alone re-parses as a bullet item whose text is
// `[ ]`, losing the checkbox, and `1.` alone is not an ordered item to the
// artifact parser, which needs whitespace after the number.
const EMPTY_ITEM_MARKER_LINE = /^[ \t]*(?:[-*+] \[[ xX]\]|\d+[.)])$/;

function normalizeMarkdown(md: string): string {
  const normalized = md
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^(.*?)[ \t]+$/gm, (_line: string, kept: string) =>
      EMPTY_ITEM_MARKER_LINE.test(kept) ? `${kept} ` : kept,
    )
    .trimStart();
  const trimmed = normalized.trimEnd();
  const lastLine = trimmed.slice(trimmed.lastIndexOf("\n") + 1);
  return normalized.charAt(trimmed.length) === " " &&
    EMPTY_ITEM_MARKER_LINE.test(lastLine)
    ? `${trimmed} `
    : trimmed;
}

export function jsonContentToMarkdown(
  content: JsonContent,
  options: SerializerOptions,
): string {
  const ctx = createContext(options, false);
  const raw = serializeNode(content, ctx);
  return normalizeMarkdown(raw);
}

/**
 * The artifact-body serialization: `jsonContentToMarkdown` plus the text
 * escaping that makes md -> doc -> md a fixed point (see
 * `escapeArtifactText` and `escapeParagraphLineStarts`). Use it wherever the
 * markdown is parsed back into the same document - the disk mirror and its
 * ingest normalization. Prompts, comments and the composer stay on
 * `jsonContentToMarkdown`.
 */
export function jsonContentToArtifactMarkdown(
  content: JsonContent,
  options: SerializerOptions,
): string {
  const ctx = createContext(options, true);
  const raw = serializeNode(content, ctx);
  return normalizeMarkdown(raw);
}
