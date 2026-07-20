import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import type { WorkspaceMentionGitType } from "@traycer/protocol/host/index";
import type { JsonContent } from "@traycer/protocol/common/registry";

import type {
  Attachment,
  EntityMentionContextType,
  ImageAttachment,
  MentionAttachment,
  PathKind,
} from "@/lib/composer/types";
import { normalizeComposerContent } from "@/lib/composer/composer-content-normalizer";

const LEADING_SLASH_COMMAND_REGEX = /^\/([A-Za-z0-9][A-Za-z0-9:_-]*)(?=$|\s)/;

const ARTIFACT_CONTEXT_TYPES: ReadonlyArray<EpicArtifactKind> = [
  "spec",
  "ticket",
  "story",
  "review",
];

const GIT_TYPES: ReadonlyArray<WorkspaceMentionGitType> = [
  "against_uncommitted_changes",
  "against_branch",
  "against_commit",
];

export function buildSubmittedChatJSONContent(
  promptContent: JsonContent,
): JsonContent {
  return contentWithLeadingSlashCommandNode(
    normalizeComposerContent(promptContent),
  );
}

export function extractPlainTextFromComposerJSONContent(
  content: JsonContent,
): string {
  return plainTextFromNodes(content.content ?? []);
}
function collectMentionAttachmentsFromJSONContent(
  content: JsonContent,
): MentionAttachment[] {
  return dedupeMentions(
    collectMentionAttachmentsFromNodes(content.content ?? []),
  );
}

export function collectImageAttachmentsFromJSONContent(
  content: JsonContent,
): ImageAttachment[] {
  return collectImageAttachmentsFromNodes(content.content ?? []);
}

export function buildAttachmentsFromJSONContent(
  content: JsonContent,
): Attachment[] {
  return [
    ...collectImageAttachmentsFromJSONContent(content),
    ...collectMentionAttachmentsFromJSONContent(content),
  ];
}

export function mentionAttrsFromAttachment(
  mention: MentionAttachment,
): Record<string, unknown> {
  if (mention.contextType === "file" || mention.contextType === "folder") {
    return {
      contextType: mention.contextType,
      id: mention.absolutePath ?? mention.relPath,
      path: mention.path,
      pathKind: mention.pathKind,
      relPath: mention.relPath,
      absolutePath: mention.absolutePath,
      workspacePath: mention.workspacePath,
      label: mention.label,
      description: mention.description,
    };
  }

  if (mention.contextType === "worktree") {
    return {
      contextType: "worktree",
      id: mention.worktreePath,
      path: mention.path,
      pathKind: null,
      relPath: null,
      absolutePath: mention.absolutePath,
      workspacePath: mention.workspacePath,
      label: mention.label,
      description: mention.description,
      worktreePath: mention.worktreePath,
      branch: mention.branch,
      isMain: mention.isMain,
    };
  }

  if (mention.contextType === "git") {
    return {
      contextType: "git",
      id: mention.path,
      path: mention.path,
      pathKind: null,
      relPath: null,
      absolutePath: null,
      workspacePath: mention.workspacePath,
      label: mention.label,
      description: mention.description,
      gitType: mention.gitType,
      branchName: mention.branchName,
      commitHash: mention.commitHash,
    };
  }

  if (isEntityMentionAttachment(mention)) {
    return {
      contextType: mention.contextType,
      id: entityMentionId(mention),
      path: mention.path,
      pathKind: null,
      relPath: null,
      absolutePath: null,
      workspacePath: null,
      label: mention.label,
      description: mention.description,
      epicId: mention.epicId,
      artifactId: mention.artifactId,
      artifactType: mention.artifactType,
      chatId: mention.chatId,
      status: mention.status,
    };
  }

  return {};
}

export function mentionAttachmentFromAttrs(
  attrs: Record<string, unknown> | undefined,
): MentionAttachment | null {
  if (attrs === undefined) return null;

  const contextType = stringValue(attrs.contextType);
  if (contextType === "file" || contextType === "folder") {
    return pathMentionAttachmentFromAttrs(attrs, contextType);
  }
  if (contextType === "worktree") {
    return worktreeMentionAttachmentFromAttrs(attrs);
  }
  if (contextType === "git") {
    return gitMentionAttachmentFromAttrs(attrs);
  }
  if (contextType === "epic" || contextType === "chat") {
    return entityMentionAttachmentFromAttrs(attrs, contextType);
  }
  if (isArtifactContextType(contextType)) {
    return entityMentionAttachmentFromAttrs(attrs, contextType);
  }
  return null;
}

export function mentionPlainTextFromAttrs(
  attrs: Record<string, unknown> | undefined,
): string {
  if (attrs === undefined) return "";

  const mention = mentionAttachmentFromAttrs(attrs);
  if (mention === null) return "";
  return `@${mention.path}`;
}

export function parseLeadingSlashCommand(
  prompt: string,
): { readonly name: string; readonly end: number } | null {
  const match = LEADING_SLASH_COMMAND_REGEX.exec(prompt);
  if (match === null) return null;
  return { name: match[1], end: match[0].length };
}

function contentWithLeadingSlashCommandNode(content: JsonContent): JsonContent {
  const state = { complete: false, changed: false };
  const nodes = nodesWithLeadingSlashCommandNode([content], state);
  if (!state.changed) return content;
  return nodes[0];
}

function nodesWithLeadingSlashCommandNode(
  nodes: ReadonlyArray<JsonContent>,
  state: { complete: boolean; changed: boolean },
): JsonContent[] {
  return nodes.flatMap((node) => nodeWithLeadingSlashCommandNode(node, state));
}

function nodeWithLeadingSlashCommandNode(
  node: JsonContent,
  state: { complete: boolean; changed: boolean },
): JsonContent[] {
  if (state.complete) return [node];
  if (node.type === "imageAttachment" || node.type === "attachmentGroup") {
    return [node];
  }
  if (node.type === "slashCommand") {
    state.complete = true;
    return [node];
  }
  if (node.type === "text") {
    const text = node.text ?? "";
    if (text.length === 0) return [node];
    state.complete = true;
    const parsed = parseLeadingSlashCommand(text);
    if (parsed === null) return [node];
    const rest = text.slice(parsed.end);
    state.changed = true;
    return [
      slashCommandNodeFromName(parsed.name),
      ...(rest.length === 0 ? [] : [{ ...node, text: rest }]),
    ];
  }

  // A leading `/command` only becomes a chip in the document's first paragraph.
  // Other leading blocks (code blocks, list items, etc.) are not command
  // contexts, so end the scan instead of recursing - otherwise a leading
  // ```/plan``` fence or `- /plan` list item would get a slashCommand node
  // spliced inside it, producing schema-invalid submitted content.
  if (node.type !== "doc" && node.type !== "paragraph") {
    state.complete = true;
    return [node];
  }

  const children = node.content;
  if (children === undefined) {
    state.complete = true;
    return [node];
  }
  const normalizedChildren = nodesWithLeadingSlashCommandNode(children, state);
  if (node.type !== "doc") state.complete = true;
  if (sameJsonContentArray(normalizedChildren, children)) return [node];
  return [
    {
      ...node,
      content: normalizedChildren,
    },
  ];
}

function sameJsonContentArray(
  left: ReadonlyArray<JsonContent>,
  right: ReadonlyArray<JsonContent>,
): boolean {
  return (
    left.length === right.length &&
    left.every((node, index) => node === right[index])
  );
}

function slashCommandNodeFromName(name: string): JsonContent {
  return {
    type: "slashCommand",
    attrs: {
      commandName: name,
    },
  };
}

// Builds a paragraph node for a leading `/command` paste (e.g. a next-step
// prompt copied as plain text). The command becomes a slashCommand chip and the
// remainder is kept as literal text (split on newlines into hardBreaks) so
// command arguments are not markdown-transformed - matching what the user gets
// when typing the command and picking it from the suggestion popover. The caller
// passes the catalog's canonical command name so the chip carries the same
// casing the popover would produce.
export function slashCommandParagraph(
  commandName: string,
  remainder: string,
): JsonContent {
  // A bare `/command` paste (empty remainder) gets a trailing space so the chip
  // stays a separate token if the user types arguments right after it. Without
  // it the prompt serializes as `/commandargs` and the host - which only routes
  // a slash command followed by whitespace or end-of-string - drops it. Mirrors
  // the typed suggestion-commit path, which also appends a space after the chip.
  const inlineText = remainder.length === 0 ? " " : remainder;
  return {
    type: "paragraph",
    content: [
      slashCommandNodeFromName(commandName),
      ...literalTextInlineNodes(inlineText),
    ],
  };
}

function literalTextInlineNodes(text: string): JsonContent[] {
  if (text.length === 0) return [];
  // Split on CRLF, lone CR, and LF so Windows clipboard text (`\r\n`) does not
  // leak carriage returns into the inserted text nodes.
  return text.split(/\r\n?|\n/).flatMap((segment, index) => {
    const breakNode: JsonContent[] = index === 0 ? [] : [{ type: "hardBreak" }];
    if (segment.length === 0) return breakNode;
    return [...breakNode, { type: "text", text: segment }];
  });
}

export function slashCommandPlainTextFromAttrs(
  attrs: Record<string, unknown> | undefined,
): string {
  const name = slashCommandNameFromAttrs(attrs);
  if (name === null) return "";
  return `/${name}`;
}

/**
 * What the chip reads on screen, which is not always what it serializes to.
 *
 * A skill picked with `$` keeps that character in its label so the composer
 * shows back what was typed, while `slashCommandPlainTextFromAttrs` still emits
 * the canonical `/name` the provider and the round-trip parser expect. Skills
 * reach the host through `skillInvocations`, keyed off the node's `kind` rather
 * than this text, so the trigger stays a purely local affordance.
 */
export function slashCommandLabelFromAttrs(
  attrs: Record<string, unknown> | undefined,
): string {
  const name = slashCommandNameFromAttrs(attrs);
  if (name === null) return "";
  return `${stringValue(attrs?.trigger) === "$" ? "$" : "/"}${name}`;
}

function slashCommandNameFromAttrs(
  attrs: Record<string, unknown> | undefined,
): string | null {
  const name =
    stringValue(attrs?.commandName) ??
    stringValue(attrs?.name) ??
    stringValue(attrs?.id);
  if (name === null) return null;
  return name.replace(/^[/$]+/, "");
}

function entityMentionId(
  mention: Extract<MentionAttachment, { readonly epicId: string }>,
): string {
  if (mention.contextType === "epic") return mention.epicId;
  if (mention.contextType === "chat") return mention.chatId ?? mention.path;
  return mention.artifactId ?? mention.path;
}

function plainTextFromNodes(content: ReadonlyArray<JsonContent>): string {
  return content
    .flatMap((node) => {
      const text = plainTextFromNode(node);
      return text.length > 0 ? [text] : [];
    })
    .join("\n");
}

function plainTextFromNode(node: JsonContent): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") return mentionPlainTextFromAttrs(node.attrs);
  if (node.type === "slashCommand") {
    return slashCommandPlainTextFromAttrs(node.attrs);
  }
  if (node.type === "imageAttachment") return "";
  if (node.type === "attachmentGroup") return "";
  if (node.type === "blockquote") return blockquotePlainText(node);
  return (node.content ?? []).map((child) => plainTextFromNode(child)).join("");
}

function blockquotePlainText(node: JsonContent): string {
  const text = (node.content ?? [])
    .map((child) => plainTextFromNode(child))
    .join("\n");
  return quotePrefixLines(text);
}

/**
 * The single markdown-quote prefix rule for every plain-text projection of a
 * blockquote (submit `contentText` here, composer copy in
 * `composer-clipboard.ts`). Blank lines become a bare `>` so the quote stays
 * one contiguous block. Child serialization legitimately differs per caller;
 * only this prefixing rule is shared.
 */
export function quotePrefixLines(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n");
}

function collectMentionAttachmentsFromNodes(
  content: ReadonlyArray<JsonContent>,
): MentionAttachment[] {
  return content.flatMap((node) => {
    if (node.type === "mention") {
      const mention = mentionAttachmentFromAttrs(node.attrs);
      return mention === null ? [] : [mention];
    }
    return collectMentionAttachmentsFromNodes(node.content ?? []);
  });
}

function collectImageAttachmentsFromNodes(
  content: ReadonlyArray<JsonContent>,
): ImageAttachment[] {
  return content.flatMap((node) => {
    if (node.type === "imageAttachment") {
      const image = imageAttachmentFromAttrs(node.attrs);
      return image === null ? [] : [image];
    }
    return collectImageAttachmentsFromNodes(node.content ?? []);
  });
}

function imageAttachmentFromAttrs(
  attrs: Record<string, unknown> | undefined,
): ImageAttachment | null {
  if (attrs === undefined) return null;
  const fileName = stringValue(attrs.fileName);
  const mimeType = stringValue(attrs.mimeType) ?? "image/png";
  const hash = stringValue(attrs.hash);
  const b64 = stringValue(attrs.b64content);
  // Persisted images carry `hash`; draft/optimistic ones still carry inline
  // `b64content`. One of the two must be present.
  if (hash === null && b64 === null) return null;
  return {
    kind: "image",
    hash,
    mediaType: mimeType,
    dataUrl: b64 === null ? null : `data:${mimeType};base64,${b64}`,
    name: fileName ?? undefined,
    size: numberValue(attrs.size) ?? undefined,
  };
}

function dedupeMentions(
  mentions: ReadonlyArray<MentionAttachment>,
): MentionAttachment[] {
  return Array.from(
    new Map(mentions.map((mention) => [mentionKey(mention), mention])).values(),
  );
}

function mentionKey(mention: MentionAttachment): string {
  return [
    mention.contextType,
    mention.path,
    mention.workspacePath ?? "",
    "epicId" in mention ? mention.epicId : "",
    "artifactId" in mention ? (mention.artifactId ?? "") : "",
    "chatId" in mention ? (mention.chatId ?? "") : "",
  ].join("\x1f");
}

function pathMentionAttachmentFromAttrs(
  attrs: Record<string, unknown>,
  contextType: PathKind,
): MentionAttachment | null {
  const path =
    stringValue(attrs.path) ??
    stringValue(attrs.relPath) ??
    stringValue(attrs.id);
  if (path === null) return null;

  return {
    kind: "mention",
    contextType,
    path,
    pathKind: pathKindValue(attrs.pathKind) ?? contextType,
    relPath: stringValue(attrs.relPath) ?? path,
    absolutePath: stringValue(attrs.absolutePath),
    workspacePath: stringValue(attrs.workspacePath),
    label: stringValue(attrs.label) ?? path,
    description:
      stringValue(attrs.description) ?? stringValue(attrs.absolutePath) ?? path,
  };
}

function worktreeMentionAttachmentFromAttrs(
  attrs: Record<string, unknown>,
): MentionAttachment | null {
  const worktreePath =
    stringValue(attrs.worktreePath) ??
    stringValue(attrs.path) ??
    stringValue(attrs.id);
  if (worktreePath === null) return null;

  return {
    kind: "mention",
    contextType: "worktree",
    path: stringValue(attrs.path) ?? worktreePath,
    pathKind: null,
    relPath: null,
    absolutePath: stringValue(attrs.absolutePath) ?? worktreePath,
    workspacePath: stringValue(attrs.workspacePath),
    label: stringValue(attrs.label) ?? worktreePath,
    description: stringValue(attrs.description) ?? worktreePath,
    worktreePath,
    branch: stringValue(attrs.branch),
    isMain: attrs.isMain === true,
  };
}

function gitMentionAttachmentFromAttrs(
  attrs: Record<string, unknown>,
): MentionAttachment | null {
  const path = stringValue(attrs.path) ?? stringValue(attrs.id);
  const gitType = gitTypeValue(attrs.gitType);
  if (path === null || gitType === null) return null;

  return {
    kind: "mention",
    contextType: "git",
    path,
    pathKind: null,
    relPath: null,
    absolutePath: null,
    workspacePath: stringValue(attrs.workspacePath),
    label: stringValue(attrs.label) ?? path,
    description: stringValue(attrs.description) ?? path,
    gitType,
    branchName: stringValue(attrs.branchName),
    commitHash: stringValue(attrs.commitHash),
  };
}

function entityMentionAttachmentFromAttrs(
  attrs: Record<string, unknown>,
  contextType: EntityMentionContextType,
): MentionAttachment | null {
  const epicId = stringValue(attrs.epicId);
  const id = stringValue(attrs.id);
  const path =
    stringValue(attrs.path) ?? entityPathFromAttrs(attrs, contextType);
  if (epicId === null || path === null) return null;

  const artifactType =
    artifactKindValue(attrs.artifactType) ?? artifactKindValue(contextType);
  return {
    kind: "mention",
    contextType,
    path,
    pathKind: null,
    relPath: null,
    absolutePath: null,
    workspacePath: null,
    label: stringValue(attrs.label) ?? path,
    description: stringValue(attrs.description) ?? path,
    epicId,
    artifactId:
      contextType === "epic" || contextType === "chat"
        ? null
        : (stringValue(attrs.artifactId) ?? id),
    artifactType,
    chatId: contextType === "chat" ? (stringValue(attrs.chatId) ?? id) : null,
    status: statusValue(attrs.status),
  };
}

function entityPathFromAttrs(
  attrs: Record<string, unknown>,
  contextType: EntityMentionContextType,
): string | null {
  const epicId = stringValue(attrs.epicId);
  const id = stringValue(attrs.id);
  if (contextType === "epic") return epicId === null ? id : `epic:${epicId}`;
  if (id === null || epicId === null) return null;
  return `${contextType}:${epicId}/${id}`;
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pathKindValue(value: unknown): PathKind | null {
  return value === "file" || value === "folder" ? value : null;
}

function artifactKindValue(value: unknown): EpicArtifactKind | null {
  return isArtifactContextType(value) ? value : null;
}

function gitTypeValue(value: unknown): WorkspaceMentionGitType | null {
  return GIT_TYPES.find((gitType) => gitType === value) ?? null;
}

function statusValue(value: unknown): string | number | null {
  if (typeof value === "string" || typeof value === "number") return value;
  return null;
}

function isArtifactContextType(value: unknown): value is EpicArtifactKind {
  return ARTIFACT_CONTEXT_TYPES.some((contextType) => contextType === value);
}

function isEntityMentionAttachment(
  mention: MentionAttachment,
): mention is Extract<MentionAttachment, { readonly epicId: string }> {
  return "epicId" in mention;
}
