import type { JsonContent } from "@traycer/protocol/common/registry";

import type {
  Attachment,
  BrowserTabMentionAttachment,
  GithubMentionAttachment,
  ImageAttachment,
  MentionAttachment,
  SlashCommand,
  SlashCommandTrigger,
} from "@/lib/composer/types";
import { normalizeComposerContent } from "@/lib/composer/composer-content-normalizer";
import {
  mentionAttachmentFromAttrs,
  numberValue,
  stringValue,
} from "@traycer/protocol/common/composer-mention-attrs";
import {
  extractPlainTextFromComposerJSONContent,
  extractPlainTextFromComposerNodes,
  mentionPlainTextFromAttrs,
  quotePrefixLines,
  slashCommandLabelFromAttrs,
  slashCommandPlainTextFromAttrs,
} from "@traycer/protocol/common/composer-plain-text";

/**
 * The plain-text projection and the mention-attribute decode it runs on now
 * live in `@traycer/protocol/common` - `composer-plain-text.ts` and
 * `composer-mention-attrs.ts` - because the host builds a transcript row's
 * minimap preview with the SAME projection, and a preview computed from a
 * second copy would drift from the label the renderer draws.
 *
 * They are re-exported here under their original names deliberately: this
 * module has ~20 importers across the GUI, and the point of the move was to
 * share one implementation, not to rename every call site. Import either path;
 * they are the same function object.
 */
export {
  extractPlainTextFromComposerJSONContent,
  mentionAttachmentFromAttrs,
  mentionPlainTextFromAttrs,
  numberValue,
  quotePrefixLines,
  slashCommandLabelFromAttrs,
  slashCommandPlainTextFromAttrs,
  stringValue,
};

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

/**
 * Whether the leading-token scan reads THROUGH this node instead of settling
 * its leading token on it.
 *
 * Every member projects to nothing the regex above would refuse in front of a
 * trigger: an indent-only text node is the `[ \t]*` the regex itself accepts,
 * and the attachment atoms project to `""` outright (`composer-plain-text.ts`
 * returns the empty string for both). So passing over one cannot change what
 * the prompt reads at its leading position - which is why the scan may, and
 * must, keep going.
 *
 * Exported because `content-recovery` has to answer the same question about a
 * slash chip - "is it in the position the converter rebuilds from?" - and
 * answering it by hand-mirroring this scan has now drifted TWICE: a chip in a
 * leading blockquote, then a chip behind an indent-only text node, which the
 * classifier called lost while this scan happily chipped it. A mirror drifts;
 * a shared predicate cannot. Consume this rather than restating it.
 */
export function isTransparentToLeadingScan(node: JsonContent): boolean {
  if (node.type === "imageAttachment" || node.type === "attachmentGroup") {
    return true;
  }
  return node.type === "text" && INDENT_ONLY_REGEX.test(node.text ?? "");
}

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

export function collectMentionAttachmentsFromJSONContent(
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

  if (isBrowserTabMentionAttachment(mention)) {
    return {
      contextType: "browser-tab",
      id: mention.tabId,
      path: mention.path,
      pathKind: null,
      relPath: null,
      absolutePath: null,
      workspacePath: null,
      label: mention.label,
      description: mention.description,
      tabId: mention.tabId,
      sessionId: mention.sessionId,
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
  const text = extractPlainTextFromComposerNodes(rest);
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
  // Indent-only text never reaches here - the caller reads through it via
  // `isTransparentToLeadingScan`, which owns that rule for every node kind at
  // once. So a text node arriving here carries something, and whatever it
  // starts with IS the leading token.
  const text = node.text ?? "";
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
  // Read through, don't settle on. One predicate for both members - the atoms
  // that project to nothing and the indent the regex accepts - so the text
  // branch below never has to re-ask.
  if (isTransparentToLeadingScan(node)) return [node];
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

function isBrowserTabMentionAttachment(
  mention: MentionAttachment,
): mention is BrowserTabMentionAttachment {
  return mention.contextType === "browser-tab";
}
