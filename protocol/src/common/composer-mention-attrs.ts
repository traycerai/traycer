import type { WorkspaceMentionGitType } from "@traycer/protocol/host/workspace/unary-schemas";

import type { EpicArtifactKind } from "./registry";
import { DEFAULT_GITHUB_MENTION_HOST } from "./github-mention-host";
import { githubMentionTokenReference } from "./github-mention-identity";

/**
 * What a composer mention node's `attrs` bag MEANS.
 *
 * A `mention` node in a persisted `JsonContent` document is an open attribute
 * bag - `Record<string, unknown>` by schema - and every surface that reads one
 * has to answer the same question: which of `path` / `relPath` / `id` /
 * `worktreePath` names this chip, and what is the fallback when the field the
 * node was written with is absent. That resolution is the whole subject of this
 * module, and it is deliberately NOT restated per consumer: the branches below
 * each resolve their path as `attrs.path ?? <branch-specific fallback>`, so
 * reading `attrs.path` directly is right for most chips and silently wrong for
 * the GitHub one, which carries no `path` of its own at all.
 *
 * It lives in `common/` rather than in the GUI because the same resolution now
 * has two consumers that must not disagree: the renderer, which draws a chip's
 * label, and {@link ../persistence/chat-transcript/build-skeleton}'s preview,
 * which the host computes for a row the client has not loaded yet. A preview
 * that resolved a path differently from the label would show a different chat
 * in the minimap than in the transcript. The GUI's
 * `lib/composer/tiptap-json-content.ts` and `lib/composer/types.ts` re-export
 * everything here, so no GUI import path changed when it moved.
 *
 * The attachment shapes are the DECODED form; the encoder that writes attrs
 * back out (`mentionAttrsFromAttachment`) is still GUI-local, because only the
 * composer creates chips.
 *
 * ## The `host/` import above is type-only, and must stay that way
 *
 * `common/` is the base layer: `host/` imports from it freely, and this is one
 * of the only edges pointing back. It is safe solely because `import type` is
 * erased at emit, so nothing of it survives into the module graph.
 *
 * A VALUE import of the same module would close a real cycle today, not a
 * theoretical one:
 *
 * ```
 * common/composer-mention-attrs -> host/workspace/unary-schemas
 *                               -> host/epic/unary-schemas
 *                               -> common/registry
 * ```
 *
 * and these are zod modules, so the failure would be evaluation-order flake at
 * import time rather than an honest error. If you need a runtime value that
 * lives under `host/`, move the value down into `common/` instead of reaching
 * up for it. `WorkspaceMentionGitType` is imported rather than restated because
 * `GIT_TYPES` below must not drift from the wire enum it mirrors - the type
 * costs nothing, the three literals are the part worth keeping honest.
 */

export type PathKind = "file" | "folder";

/**
 * Wire spelling, not a local one: matches `ContextType.BrowserTab` in the
 * json-content serializer. A browser tab is readable but not itself an Agent,
 * so it stays a SIBLING of the entity kinds rather than folding into them -
 * those carry epic-scoped fields a tab has no use for.
 */
export type BrowserTabMentionContextType = "browser-tab";

/**
 * The epic-scoped entities a mention chip can DECODE to an attachment.
 *
 * Every member is reachable: `mentionAttachmentFromAttrs` names these four
 * literals and the artifact kinds explicitly before falling through to `null`,
 * and `entityMentionAttachmentFromAttrs` - the only producer of an
 * `EntityMentionAttachment` - is called from nowhere else.
 *
 * `"user"` is deliberately NOT here, and its absence is not an oversight to
 * correct. A user mention is real and renders as `@name`, but it is the
 * SERIALIZER's concern: `ContextType.User` in `json-content-serializer.ts` has
 * its own branches for both the LLM and plain-text forms, reading the node's
 * raw attrs. It is not an epic-scoped entity - it carries no `epicId`, which
 * this decoder requires - so listing it here only ever widened a type past
 * what any code path could produce.
 */
export type EntityMentionContextType =
  | "epic"
  | "chat"
  | "terminal-agent"
  | "terminal"
  | EpicArtifactKind;

/**
 * Wire spelling, not a local one: these strings ARE `ContextType` members in
 * `json-content-serializer.ts`, which reads the mention node's `contextType`
 * attribute straight off the submitted document. Renaming them here would
 * silently stop the serializer recognizing the chip.
 */
export type GithubMentionContextType = "github_pull_request" | "github_issue";

export type FileMentionAttachment = {
  kind: "mention";
  contextType: "file" | "folder";
  path: string;
  pathKind: PathKind;
  relPath: string;
  absolutePath: string | null;
  workspacePath: string | null;
  label: string;
  description: string;
};

export type GitMentionAttachment = {
  kind: "mention";
  contextType: "git";
  path: string;
  pathKind: null;
  relPath: null;
  absolutePath: null;
  workspacePath: string | null;
  label: string;
  description: string;
  gitType: WorkspaceMentionGitType;
  branchName: string | null;
  commitHash: string | null;
};

export type WorktreeMentionAttachment = {
  kind: "mention";
  contextType: "worktree";
  // The worktree's absolute directory; this is what serializes to the agent
  // as `@<path>` since the worktree lives outside the workspace root.
  path: string;
  pathKind: null;
  relPath: null;
  absolutePath: string | null;
  workspacePath: string | null;
  label: string;
  description: string;
  worktreePath: string;
  branch: string | null;
  isMain: boolean;
};

export type EntityMentionAttachment = {
  kind: "mention";
  contextType: EntityMentionContextType;
  path: string;
  pathKind: null;
  relPath: null;
  absolutePath: null;
  workspacePath: null;
  label: string;
  description: string;
  epicId: string;
  artifactId: string | null;
  artifactType: EpicArtifactKind | null;
  chatId: string | null;
  terminalAgentId: string | null;
  /** Session id of a plain terminal mention; null for every other entity. */
  terminalId: string | null;
  status: string | number | null;
};

/**
 * A GitHub pull request or issue the composer references.
 *
 * What travels is a STABLE REFERENCE, never inlined content: provider, kind,
 * `org/repo#number`, and the URL. The agent resolves detail with its own tools
 * at read time, exactly as a file mention hands over a path rather than the
 * file's bytes - so the reference cannot go stale between insert and send, and
 * the URL keeps it resolvable where `gh` is not signed in.
 *
 * The field names are the serializer's (`organizationLogin`, `repositoryName`,
 * `issueNumber`, `githubHost`, `url`), because these become the mention node's
 * attributes verbatim and `formatMentionForLLMQuery` reads them by name.
 */
export type GithubMentionAttachment = {
  kind: "mention";
  contextType: GithubMentionContextType;
  /** The entity token: `github-pr:org/repo#123` / `github-issue:org/repo#123`. */
  path: string;
  pathKind: null;
  relPath: null;
  absolutePath: null;
  workspacePath: null;
  label: string;
  description: string;
  githubHost: string;
  organizationLogin: string;
  repositoryName: string;
  issueNumber: number;
  url: string;
};

/**
 * A browser tab chip. `tabId` is the only field that must survive - it is what
 * `page.attachTab({tabId})` resolves - so `path` is DERIVED from it rather than
 * trusted verbatim, and a node carrying a stale `path` still round-trips to the
 * tab its `tabId` names. `label`/`url` are display-only (the live decorator's
 * tooltip fallback once the tab is gone); `description` is unused for this
 * variant and kept at `""` only because every member carries the field.
 */
export type BrowserTabMentionAttachment = {
  kind: "mention";
  contextType: BrowserTabMentionContextType;
  path: string;
  pathKind: null;
  relPath: null;
  absolutePath: null;
  workspacePath: null;
  label: string;
  description: string;
  tabId: string;
  sessionId: string;
  url: string;
};

export type MentionAttachment =
  | FileMentionAttachment
  | WorktreeMentionAttachment
  | GitMentionAttachment
  | EntityMentionAttachment
  | GithubMentionAttachment
  | BrowserTabMentionAttachment;

/** Same shape and same reason as {@link GIT_TYPES} - a subset would compile. */
const ARTIFACT_CONTEXT_TYPES: Readonly<Record<EpicArtifactKind, true>> = {
  spec: true,
  ticket: true,
  story: true,
  review: true,
};

/**
 * A RECORD keyed by the union, not an array of it.
 *
 * `ReadonlyArray<WorkspaceMentionGitType>` accepts any SUBSET, so the header's
 * claim that importing the wire type keeps this list from drifting was not
 * something the annotation could enforce: a new member added to the enum
 * compiled here unchanged and then decoded to `null` in `gitTypeValue`, which
 * drops the chip's attachment and its plain-text projection with no error
 * anywhere. Keyed by the union, omitting one is a compile error.
 */
const GIT_TYPES: Readonly<Record<WorkspaceMentionGitType, true>> = {
  against_uncommitted_changes: true,
  against_branch: true,
  against_commit: true,
};

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
  if (contextType === "browser-tab") {
    return browserTabMentionAttachmentFromAttrs(attrs);
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

function isGitType(value: unknown): value is WorkspaceMentionGitType {
  return typeof value === "string" && Object.hasOwn(GIT_TYPES, value);
}

function gitTypeValue(value: unknown): WorkspaceMentionGitType | null {
  return isGitType(value) ? value : null;
}

/** See {@link BrowserTabMentionAttachment} for why `path` is derived. */
function browserTabMentionAttachmentFromAttrs(
  attrs: Record<string, unknown>,
): MentionAttachment | null {
  const tabId = stringValue(attrs.tabId) ?? stringValue(attrs.id);
  if (tabId === null) return null;
  return {
    kind: "mention",
    contextType: "browser-tab",
    path: `browser-tab:${tabId}`,
    pathKind: null,
    relPath: null,
    absolutePath: null,
    workspacePath: null,
    label: stringValue(attrs.label) ?? "Browser",
    description: stringValue(attrs.description) ?? stringValue(attrs.url) ?? "",
    tabId,
    sessionId: stringValue(attrs.sessionId) ?? "",
    url: stringValue(attrs.url) ?? "",
  };
}

function statusValue(value: unknown): string | number | null {
  if (typeof value === "string" || typeof value === "number") return value;
  return null;
}

function isArtifactContextType(value: unknown): value is EpicArtifactKind {
  return (
    typeof value === "string" && Object.hasOwn(ARTIFACT_CONTEXT_TYPES, value)
  );
}
