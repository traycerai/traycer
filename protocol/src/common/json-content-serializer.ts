import type { JsonContent } from "./registry";

export enum ContextType {
  File = "file",
  Folder = "folder",
  Worktree = "worktree",
  GithubIssue = "github_issue",
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
  orderedListIndex: number;
  inListItem: boolean;
}

function createContext(options: SerializerOptions): SerializerContext {
  return {
    options: {
      listIndent: 2,
      bulletMarker: "-",
      ...options,
    },
    listDepth: 0,
    orderedListIndex: 0,
    inListItem: false,
  };
}

function getIndent(ctx: SerializerContext): string {
  return " ".repeat(ctx.listDepth * (ctx.options.listIndent ?? 2));
}

function escapeXmlAttr(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXmlContent(str: string): string {
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

/**
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
function serializeTextRun(nodes: JsonContent[]): string {
  const textNodes = nodes.filter((node) => Boolean(node.text));
  const nodeMarks = textNodes.map((node) => renderableMarks(node.marks));

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
      out += open[i].close;
    }
    open = open.slice(0, depth);
  };

  textNodes.forEach((node, index) => {
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
      out += mark.open;
      open.push(mark);
    }
    out += node.text ?? "";
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
  branchName?: string;
  commitHash?: string;
  gitType?: string;
  fileName?: string;
  phaseId?: string;
  reviewCommentId?: string;
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
    case ContextType.GithubIssue: {
      const org = attrs.organizationLogin || "";
      const repo = attrs.repositoryName || "";
      const issue = attrs.issueNumber || "";
      return `${org}/${repo}#${issue}`;
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
    case ContextType.GithubIssue: {
      const org = attrs.organizationLogin || "";
      const repo = attrs.repositoryName || "";
      const issue = attrs.issueNumber || "";
      return `github:${org}/${repo}#${issue}`;
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

function serializeHardBreak(): string {
  return "\n";
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

function serializeParagraph(node: JsonContent, ctx: SerializerContext): string {
  const indent = ctx.inListItem ? "" : getIndent(ctx);
  const content = serializeChildren(node.content, ctx);
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
    let index = 1;
    for (const child of node.content) {
      if (child.type === "listItem") {
        items.push(serializeListItem(child, childCtx, true, index));
        index++;
      }
    }
  }

  return items.join("\n");
}

function serializeListItem(
  node: JsonContent,
  ctx: SerializerContext,
  ordered: boolean,
  index: number,
): string {
  const baseIndent = " ".repeat(
    (ctx.listDepth - 1) * (ctx.options.listIndent ?? 2),
  );
  const marker = ordered ? `${index}.` : (ctx.options.bulletMarker ?? "-");

  const lines: string[] = [];
  let firstLine = true;

  const itemCtx: SerializerContext = {
    ...ctx,
    inListItem: true,
  };

  if (node.content) {
    for (const child of node.content) {
      const serialized = serializeNode(child, itemCtx);

      if (firstLine) {
        lines.push(`${baseIndent}${marker} ${serialized}`);
        firstLine = false;
      } else {
        const continuationIndent = " ".repeat(
          baseIndent.length + marker.length + 1,
        );
        const childLines = serialized.split("\n");
        for (const line of childLines) {
          if (child.type === "bulletList" || child.type === "orderedList") {
            lines.push(line);
          } else {
            lines.push(`${continuationIndent}${line}`);
          }
        }
      }
    }
  }

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
        const cellContent = serializeChildren(cell.content, ctx);
        // Escape backslashes before pipes so a literal trailing `\` in a cell
        // can't escape the `\|` we add and merge two cells together.
        cells.push(cellContent.replace(/\\/g, "\\\\").replace(/\|/g, "\\|"));
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
  const flushTextRun = (): void => {
    if (textRun.length > 0) {
      parts.push(serializeTextRun(textRun));
      textRun = [];
    }
  };

  for (const child of content) {
    if (child.type === "text") {
      textRun.push(child);
    } else {
      flushTextRun();
      parts.push(serializeNode(child, ctx));
    }
  }
  flushTextRun();

  return parts.join("");
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
      return serializeHardBreak();
    case "heading":
      return serializeHeading(node, ctx);
    case "bulletList":
      return serializeBulletList(node, ctx);
    case "orderedList":
      return serializeOrderedList(node, ctx);
    case "listItem":
      return serializeListItem(node, ctx, false, 0);
    case "codeBlock":
      return serializeCodeBlock(node, ctx);
    case "mermaidBlock":
      return serializeMermaidBlock(node, ctx);
    case "uiPreviewBlock":
      return serializeUIPreviewBlock(node, ctx);
    case "blockquote":
      return serializeBlockquote(node);
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

function normalizeMarkdown(md: string): string {
  return md
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

export function jsonContentToMarkdown(
  content: JsonContent,
  options: SerializerOptions,
): string {
  const ctx = createContext(options);
  const raw = serializeNode(content, ctx);
  return normalizeMarkdown(raw);
}
