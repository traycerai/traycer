import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import type { WorkspaceMentionGitType } from "@traycer/protocol/host/index";
import type { JsonContent } from "@traycer/protocol/common/registry";

import type {
  Attachment,
  EntityMentionContextType,
  GithubMentionAttachment,
  GithubMentionContextType,
  ImageAttachment,
  MentionAttachment,
  PathKind,
  SlashCommand,
  SlashCommandTrigger,
} from "@/lib/composer/types";
import { normalizeComposerContent } from "@/lib/composer/composer-content-normalizer";
import { DEFAULT_GITHUB_MENTION_HOST } from "@traycer/protocol/common/github-mention-host";
import { githubMentionTokenReference } from "@/lib/composer/mentions/github-mention-display";

// Recognizes both picker triggers. This is only the LEXICAL shape - `$` in
// particular matches far more prose than it should (`$20`, `$PATH`), so what a
// match becomes is decided by the catalog, not here. Callers gate on that; see
// `buildSubmittedChatJSONContent`.
//
// The captured trigger rides along to the node for display only: the node still
// serializes to the canonical `/name`, so nothing downstream of the composer has
// to learn about `$`.
const LEADING_SLASH_COMMAND_REGEX =
  /^([ \t]*)([/$])([A-Za-z0-9][A-Za-z0-9:_-]*)(?=$|\s)/;

// A text node the scan reads through rather than stopping on. Deliberately the
// same class the regex above accepts as indent, so "what counts as leading" has
// one definition whether the indent shares the trigger's node or not.
const INDENT_ONLY_REGEX = /^[ \t]*$/;

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

/**
 * The catalog a raw-text converter resolves a written command against, keyed by
 * lowercased name. `null` means "not loaded" - see
 * {@link buildSubmittedChatJSONContent} for what each converter does then.
 */
export type SlashCommandCatalog = ReadonlyMap<string, SlashCommand>;

/**
 * Normalizes composer content for submission, turning a leading `/command` or
 * `$skill` written as plain text into a chip.
 *
 * `catalog` is what keeps this from rewriting ordinary prose. The two triggers
 * are deliberately not symmetric here:
 *
 * - `$` chips **only** on a catalog hit. `$` leads real prose constantly -
 *   `$20 for the migration`, `$PATH is wrong` - and every one of those bodies
 *   fits the command-name grammar. Gating is the only thing that tells them
 *   apart, so with a `null` catalog a `$` prompt stays text.
 *
 *   That is safe to do, and this is the load-bearing part: the host's
 *   `parseProviderSlashPrompt` accepts a leading `$name` as well as `/name` and
 *   validates it against the real catalog. So a `$skill` left as prose here -
 *   because the catalog was still loading, or failed - is still resolved by the
 *   host, and `$20` still finds no command and stays prose. An unresolved
 *   catalog costs the user the pill, never the skill. Without that fallback
 *   every submit path in the app would have to await this catalog.
 * - `/` keeps its long-standing ungated lexical fallback, because a message that
 *   opens with `/word` is already a command by convention and the provider
 *   parses it that way regardless of what we chip.
 *
 * On a hit either trigger builds the chip from the resolved option, so a chip
 * born from raw text carries the same `kind`/`path`/`harnessId` as one the
 * picker inserted. That matters twice over: the host reads skills structurally
 * off `kind`, and the editor's leading guard deletes a kindless chip that sits
 * anywhere but the prompt start.
 */
export function buildSubmittedChatJSONContent(
  promptContent: JsonContent,
  catalog: SlashCommandCatalog | null,
): JsonContent {
  return contentWithLeadingSlashCommandNode(
    normalizeComposerContent(promptContent),
    catalog,
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

  if (isGithubMentionAttachment(mention)) {
    return {
      contextType: mention.contextType,
      // The entity token doubles as the node id, exactly as it does for every
      // other entity mention. `org/repo#123` alone is NOT unique - the same
      // one can be served by two GitHub hosts - so the token carries the host
      // whenever it is not the default. See `githubMentionToken`.
      id: mention.path,
      path: mention.path,
      pathKind: null,
      relPath: null,
      absolutePath: null,
      workspacePath: null,
      label: mention.label,
      description: mention.description,
      githubHost: mention.githubHost,
      organizationLogin: mention.organizationLogin,
      repositoryName: mention.repositoryName,
      issueNumber: mention.issueNumber,
      url: mention.url,
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
      terminalAgentId: mention.terminalAgentId,
      terminalId: mention.terminalId,
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
  if (contextType === "github_pull_request" || contextType === "github_issue") {
    return githubMentionAttachmentFromAttrs(attrs, contextType);
  }
  if (
    contextType === "epic" ||
    contextType === "chat" ||
    contextType === "terminal-agent" ||
    contextType === "terminal"
  ) {
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

export function parseLeadingSlashCommand(prompt: string): {
  readonly name: string;
  /** Offset of the trigger character; everything before it is indent. */
  readonly start: number;
  readonly end: number;
  readonly trigger: SlashCommandTrigger;
} | null {
  const match = LEADING_SLASH_COMMAND_REGEX.exec(prompt);
  if (match === null) return null;
  return {
    name: match[3],
    start: match[1].length,
    end: match[0].length,
    trigger: match[2] === "$" ? "$" : "/",
  };
}

interface LeadingSlashScanState {
  complete: boolean;
  changed: boolean;
  /**
   * Whether the sibling after the node being scanned terminates a token that
   * ends exactly at that node's edge. See {@link closesLeadingToken}.
   */
  nextClosesToken: boolean;
  readonly catalog: SlashCommandCatalog | null;
}

function contentWithLeadingSlashCommandNode(
  content: JsonContent,
  catalog: SlashCommandCatalog | null,
): JsonContent {
  const state: LeadingSlashScanState = {
    complete: false,
    changed: false,
    nextClosesToken: true,
    catalog,
  };
  const nodes = nodesWithLeadingSlashCommandNode([content], state);
  if (!state.changed) return content;
  return nodes[0];
}

function nodesWithLeadingSlashCommandNode(
  nodes: ReadonlyArray<JsonContent>,
  state: LeadingSlashScanState,
): JsonContent[] {
  return nodes.flatMap((node, index) => {
    // Only meaningful until the scan settles, and serializing the tail for every
    // node after that would be quadratic for nothing.
    if (!state.complete) {
      state.nextClosesToken = closesLeadingToken(nodes.slice(index + 1));
    }
    return nodeWithLeadingSlashCommandNode(node, state);
  });
}

/**
 * Whether the siblings after a token that ends exactly at a node boundary leave
 * it terminated - i.e. the prompt still reads `/name` followed by whitespace or
 * nothing, which is what `LEADING_SLASH_COMMAND_REGEX` requires.
 *
 * Formatting splits a run, so the character that decides this usually lives in
 * a LATER node: a bold `$review` can be followed by a plain `-code`, a plain
 * `.`, or an image atom that serializes to nothing at all. Answering per node
 * type kept getting this wrong in a new way each time, so the question is
 * delegated to the same serializer that builds the prompt - if the remainder
 * starts with whitespace or is empty, the token is closed. Attachments drop out
 * for free (they serialize to `""`), a hard break contributes a newline, and a
 * mention or another chip contributes text that correctly refuses the boundary.
 */
function closesLeadingToken(rest: ReadonlyArray<JsonContent>): boolean {
  const text = plainTextFromNodes(rest);
  return text.length === 0 || /^\s/.test(text);
}

/**
 * Splits the document's leading text node into a chip plus its remainder, when
 * that text opens with a trigger the catalog can back. Reaching a non-empty text
 * node ends the scan either way: whatever it starts with is the leading token.
 */
function textWithLeadingSlashCommandNode(
  node: JsonContent,
  state: LeadingSlashScanState,
): JsonContent[] {
  const text = node.text ?? "";
  // Indent, not the leading token. Formatting splits a run, so a marked `"   "`
  // can sit before the trigger; the editor and the host's prompt trim both read
  // straight through those spaces, and ending the scan here would hide the
  // trigger in the next node entirely. Same `[ \t]` the leading regex calls
  // indent - a hard break is a different node type and still ends the line.
  if (INDENT_ONLY_REGEX.test(text)) return [node];
  state.complete = true;
  const parsed = parseLeadingSlashCommand(text);
  if (parsed === null) return [node];
  const rest = text.slice(parsed.end);
  // The token only LOOKS complete because this node ends. Chipping it is worse
  // than not converting at all: the chip is sent structurally as `review` while
  // the text still reads `/review-code` or `/review.`, so a command the user
  // never wrote runs - whereas leaving it as prose lets the host resolve the
  // full concatenated text lexically, or refuse it exactly as we did.
  if (rest.length === 0 && !state.nextClosesToken) return [node];
  const resolved = state.catalog?.get(parsed.name.toLowerCase()) ?? null;
  // `$` is meaningless without a catalog hit - see the note on
  // `buildSubmittedChatJSONContent` - so leave the prose alone.
  if (resolved === null && parsed.trigger === "$") return [node];
  const indent = text.slice(0, parsed.start);
  state.changed = true;
  return [
    // Indent kept as its own node: the editor treats a command after leading
    // spaces as leading, and dropping them would silently edit the user's text.
    ...(indent.length === 0 ? [] : [{ ...node, text: indent }]),
    resolved === null
      ? slashCommandNodeFromName(parsed.name, parsed.trigger)
      : slashCommandNodeFromCommand(resolved, parsed.trigger),
    ...(rest.length === 0 ? [] : [{ ...node, text: rest }]),
  ];
}

function nodeWithLeadingSlashCommandNode(
  node: JsonContent,
  state: LeadingSlashScanState,
): JsonContent[] {
  if (state.complete) return [node];
  if (node.type === "imageAttachment" || node.type === "attachmentGroup") {
    return [node];
  }
  if (node.type === "slashCommand") {
    state.complete = true;
    return [node];
  }
  if (node.type === "text") return textWithLeadingSlashCommandNode(node, state);

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

/**
 * The last-resort chip: a lexically valid `/name` we could not resolve, because
 * the catalog had not loaded. It carries no `kind`, so the host falls back to
 * re-resolving the name itself and the editor's leading guard will only tolerate
 * it at the prompt start. Never produced for `$`.
 */
function slashCommandNodeFromName(
  name: string,
  trigger: SlashCommandTrigger,
): JsonContent {
  return {
    type: "slashCommand",
    attrs: {
      commandName: name,
      trigger,
    },
  };
}

/**
 * The chip a resolved command produces. Deliberately the same attribute set
 * `commitSlashInsertion` writes, so a chip is indistinguishable whether it was
 * picked from the popover, pasted, or spliced out of a next-step prompt - keep
 * the two in step.
 */
function slashCommandNodeFromCommand(
  command: SlashCommand,
  trigger: SlashCommandTrigger,
): JsonContent {
  return {
    type: "slashCommand",
    attrs: {
      commandName: command.name,
      harnessId: command.harnessId,
      kind: command.kind,
      description: command.description,
      argumentHint: command.argumentHint,
      path:
        typeof command.metadata.path === "string"
          ? command.metadata.path
          : null,
      trigger,
    },
  };
}

// Builds a paragraph node for a leading `/command` or `$skill` paste (e.g. a
// next-step prompt copied as plain text). The command becomes a slashCommand
// chip and the remainder is kept as literal text (split on newlines into
// hardBreaks) so command arguments are not markdown-transformed - matching what
// the user gets when typing the command and picking it from the suggestion
// popover. The caller passes the resolved catalog option so the chip carries the
// popover's casing, kind and path, and the trigger the paste actually led with
// so it reads back as what was pasted.
export function slashCommandParagraph(
  command: SlashCommand,
  remainder: string,
  trigger: SlashCommandTrigger,
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
      slashCommandNodeFromCommand(command, trigger),
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
 * A chip written with `$` - picked from the popover, pasted, or spliced out of a
 * next-step prompt - keeps that character in its label so both the live composer
 * and the sent message show back what was written, while
 * `slashCommandPlainTextFromAttrs` still emits the canonical `/name` the provider
 * and the round-trip parser expect. Skills reach the host through
 * `skillInvocations`, keyed off the node's `kind` rather than this text, so the
 * trigger stays a purely local affordance.
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
  if (mention.contextType === "terminal-agent") {
    return mention.terminalAgentId ?? mention.path;
  }
  if (mention.contextType === "terminal") {
    return mention.terminalId ?? mention.path;
  }
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
  // A sourced quote projects to text exactly like a blockquote - the source it
  // remembers travels in its attrs, not in the prose.
  if (node.type === "blockquote" || node.type === "sourcedQuote") {
    return blockquotePlainText(node);
  }
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

/**
 * Rebuilds a GitHub chip from its node attributes.
 *
 * A chip with no `organizationLogin`/`repositoryName`/`issueNumber` cannot be
 * turned back into a reference at all - `formatMentionForLLMQuery` would emit
 * `@github-pr:/#` - so it is rejected here and the node falls back to plain
 * text rather than shipping a broken reference to the agent.
 */
function githubMentionAttachmentFromAttrs(
  attrs: Record<string, unknown>,
  contextType: GithubMentionContextType,
): MentionAttachment | null {
  const organizationLogin = stringValue(attrs.organizationLogin);
  const repositoryName = stringValue(attrs.repositoryName);
  const issueNumber = issueNumberValue(attrs.issueNumber);
  if (
    organizationLogin === null ||
    repositoryName === null ||
    issueNumber === null
  ) {
    return null;
  }
  const prefix =
    contextType === "github_pull_request" ? "github-pr" : "github-issue";
  // github.com is the host a node without the field means; see
  // `DEFAULT_GITHUB_MENTION_HOST`.
  const githubHost =
    stringValue(attrs.githubHost) ?? DEFAULT_GITHUB_MENTION_HOST;
  const reference = `${organizationLogin}/${repositoryName}#${issueNumber}`;
  // Rebuilt through `githubMentionToken`'s own reference builder, so a chip
  // restored from its node keeps the identity the picker gave it - the rule
  // lives in one place instead of being restated here. Only reached when the
  // node carries no `path` of its own.
  const path =
    stringValue(attrs.path) ??
    `${prefix}:${githubMentionTokenReference({
      githubHost,
      owner: organizationLogin,
      repo: repositoryName,
      number: issueNumber,
    })}`;
  return {
    kind: "mention",
    contextType,
    path,
    pathKind: null,
    relPath: null,
    absolutePath: null,
    workspacePath: null,
    label: stringValue(attrs.label) ?? `#${issueNumber}`,
    description: stringValue(attrs.description) ?? reference,
    githubHost,
    organizationLogin,
    repositoryName,
    issueNumber,
    url: stringValue(attrs.url) ?? "",
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
    artifactId: isArtifactContextType(contextType)
      ? (stringValue(attrs.artifactId) ?? id)
      : null,
    artifactType,
    chatId: contextType === "chat" ? (stringValue(attrs.chatId) ?? id) : null,
    terminalAgentId:
      contextType === "terminal-agent"
        ? (stringValue(attrs.terminalAgentId) ?? id)
        : null,
    terminalId:
      contextType === "terminal" ? (stringValue(attrs.terminalId) ?? id) : null,
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

/**
 * `issueNumber` after a round-trip through HTML, where it is a STRING.
 *
 * The chip is the only mention attribute that is genuinely numeric, and
 * `dataAttributeMap` parses every attribute back with `getAttribute`, which
 * only ever returns a string. So the same chip is a `number` when it comes
 * from the picker or from persisted ProseMirror JSON, and `"123"` when the
 * user copies it and pastes it back - the editor's ordinary Cmd+C path.
 * Rejecting the string form left the pasted chip with no attachment at all:
 * a blank node view, no plain-text projection, and silent omission from the
 * submitted context.
 *
 * Deliberately strict about what it accepts: a bare run of digits, so
 * `"12abc"`, `"1.5"` and `""` are still rejected rather than being coerced
 * into a reference that points somewhere else.
 */
function issueNumberValue(value: unknown): number | null {
  // Positive SAFE INTEGER, on both paths. `numberValue` only rejects
  // non-finite, so the direct path accepted `0`, negatives and fractions, and
  // the digit-string path accepted `"0"` - each producing an attachment like
  // `github-pr:org/repo#0` that serializes a reference no catalog or search
  // response can ever contain. `githubMentionRowBaseSchema` requires a
  // positive integer on the wire; this is the same rule for the node
  // reconstruction path, which reaches attachments without passing the query
  // parser's `referenceNumber`.
  const direct = numberValue(value);
  if (direct !== null) return positiveIssueNumber(direct);
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  return positiveIssueNumber(Number(value));
}

function positiveIssueNumber(parsed: number): number | null {
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
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

function isGithubMentionAttachment(
  mention: MentionAttachment,
): mention is GithubMentionAttachment {
  return (
    mention.contextType === "github_pull_request" ||
    mention.contextType === "github_issue"
  );
}
