import type {
  GuiAgentCommandOption,
  EpicMentionSuggestion,
  WorkspaceMentionGitType,
  WorkspaceMentionSuggestion,
} from "@traycer/protocol/host/index";
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import type { TuiHarnessId } from "@traycer/protocol/persistence/epic/schemas";
import type { MentionPathTree } from "@/lib/path";
import type { BrowserAnnotationRecord } from "@traycer/protocol/persistence/epic/schemas";

export type PathKind = "file" | "folder";
export type EntityMentionContextType =
  | "epic"
  | "chat"
  | "terminal-agent"
  | "terminal"
  | EpicArtifactKind
  | "user";
/**
 * Wire spelling, not a local one: these strings ARE `ContextType` members in
 * `@traycer/protocol`'s json-content serializer, which reads the mention
 * node's `contextType` attribute straight off the submitted document. Renaming
 * them here would silently stop the serializer recognizing the chip.
 */
export type GithubMentionContextType = "github_pull_request" | "github_issue";
/**
 * Wire spelling, not a local one: matches `ContextType.BrowserTab` in
 * `@traycer/protocol`'s json-content serializer. A browser tab is readable but
 * not itself an Agent, so it stays a sibling of `GithubMentionContextType`
 * rather than folding into `EntityMentionContextType` (which carries
 * epic-scoped entity fields a browser tab has no use for).
 */
export type BrowserTabMentionContextType = "browser-tab";
export type MentionContextType =
  | PathKind
  | "git"
  | "worktree"
  | EntityMentionContextType
  | GithubMentionContextType
  | BrowserTabMentionContextType;

export type ComposerPromptSegment =
  | { type: "text"; text: string }
  | { type: "mention"; path: string };

export type WorkspaceEntry = WorkspaceMentionSuggestion;

/**
 * Which interface a referenceable Agent is interacted with through. Agent is
 * the durable entity; Chat and Terminal are interfaces on it, not sibling
 * entity types - so both arms below are Agents and both are referenceable.
 */
export type AgentMentionInterface = "chat" | "terminal";

/**
 * Fields every referenceable Agent carries, regardless of interface. The two
 * arms differ only in which durable record they name (`chatId` vs
 * `terminalAgentId`) and in the token prefix that encodes it.
 */
interface EpicAgentMentionEntryBase {
  readonly id: string;
  readonly token: string;
  readonly epicId: string;
  readonly epicTitle: string;
  readonly label: string;
  readonly description: string;
  readonly parentId: string | null;
  readonly updatedAt: number;
  /**
   * Whether the Agent's record is archived. Archived Agents stay
   * referenceable - the picker lists them - but rank below live Agents at
   * equal match quality and carry a visible badge, so a stale record never
   * shadows the active one the user almost certainly means.
   */
  readonly archived: boolean;
  readonly agentInterface: AgentMentionInterface;
  /**
   * Whether this Agent's RUNTIME supports agent-to-agent delivery at all - the
   * surface/harness arm of the host's send gate (`canReceiveA2AMessages`). It
   * is
   * deliberately NOT a claim of actual routability: the host additionally
   * requires the receiver to be same-user and host-local (`agent.list`'s
   * `capabilities.sendMessage` = `sameUser && isLocal &&
   * canReceiveA2AMessages`),
   * and the picker does not carry viewer host/user identity.
   *
   * So `false` is a definite "this runtime has no inbox" and is surfaced on the
   * row; `true` means only "not ruled out here" and is surfaced as nothing at
   * all. The picker inserts a REFERENCE - delivery is attempted elsewhere and
   * the host returns the authoritative error (e.g. `RECEIVER_NOT_LOCAL`), so an
   * unmarked row never promises the message will land.
   *
   * Referenceability is a SEPARATE capability either way: this field changes
   * how a row is labelled, never whether it is listed.
   */
  readonly runtimeSupportsMessageDelivery: boolean;
}

export interface EpicChatMentionEntry extends EpicAgentMentionEntryBase {
  readonly kind: "epic-chat";
  readonly agentInterface: "chat";
  readonly chatId: string;
}

export interface EpicTerminalAgentMentionEntry extends EpicAgentMentionEntryBase {
  readonly kind: "epic-terminal-agent";
  readonly agentInterface: "terminal";
  readonly terminalAgentId: string;
  /** Coding agent backing the Terminal interface; disambiguates same-named rows. */
  readonly harnessId: TuiHarnessId;
}

export type EpicAgentMentionEntry =
  | EpicChatMentionEntry
  | EpicTerminalAgentMentionEntry;

/**
 * A plain interactive terminal in the open Task - the shell itself, not an
 * Agent reached through one. Deliberately NOT an `EpicAgentMentionEntry` arm:
 * a coding agent can only READ a terminal (it has no inbox), so it carries
 * none of the Agent interface/delivery metadata and lists under its own
 * category.
 *
 * Sourced from the same host `terminal.list` rows the Task's Terminals sidebar
 * renders, so the picker and that panel never disagree about what exists.
 */
export interface EpicTerminalMentionEntry {
  readonly kind: "epic-terminal";
  readonly id: string;
  readonly token: string;
  readonly epicId: string;
  readonly terminalId: string;
  /** Terminal title, resolved exactly as the sidebar row resolves it. */
  readonly label: string;
  readonly description: string;
  readonly cwd: string;
  /** Session start time - terminals carry no separate "updated" clock. */
  readonly updatedAt: number;
}

export type EpicMentionEntry = EpicMentionSuggestion | EpicAgentMentionEntry;

/**
 * One browser tab as the @-mention picker lists it - sourced live from
 * `useMaybeBrowserSessionsContext()`, not a host RPC, so every field is
 * already resolved when the entry is built.
 *
 * `coLocated` and `lastActivityAt` are ranking hints only, never rendered:
 * the co-located-pane-group ranking the design calls for needs the chat's
 * `viewTabId`/tile identity threaded into the mention context, which is
 * disproportionately invasive here (see `providers.tsx`'s
 * `rankBrowserTabEntries`). `coLocated` is `tab.viewed` - the session
 * stream's own "currently viewed" hint - used as the closest cheap proxy:
 * a real pane-group walk ranks a sibling-pane tab first regardless of which
 * tab a person is looking at, while this ranks whichever tab the stream
 * already marks as viewed, so the two agree only when that also happens to
 * be the co-located one.
 */
export interface BrowserTabMentionEntry {
  readonly kind: "browser-tab";
  readonly id: string;
  readonly tabId: string;
  readonly sessionId: string;
  readonly label: string;
  readonly url: string;
  readonly coLocated: boolean;
  readonly lastActivityAt: number;
  /**
   * `tab.status === "dormant"` (the sidebar's own source of truth for its
   * Moon glyph - `epic-browser-sidebar-row.tsx`). Dormant tabs ARE listed
   * and mentionable: `page.attachTab` auto-wakes a dormant session before
   * leasing it, so this is a display hint (renders the Moon glyph, demotes
   * the row a notch in ranking) and never a filter.
   */
  readonly dormant: boolean;
}

export type MentionSuggestionEntry =
  | WorkspaceEntry
  | EpicMentionEntry
  | EpicTerminalMentionEntry
  | BrowserTabMentionEntry;

export type ImageAttachment = {
  kind: "image";
  // Content hash for persisted images (bytes live in the epic doc's attachments
  // map, fetched lazily into a blob URL). Null for draft/optimistic images that
  // still carry inline bytes via `dataUrl`.
  hash: string | null;
  mediaType: string;
  // Inline `data:` URL for draft/optimistic rendering; null for persisted
  // images (rendered from `hash` via the blob cache).
  dataUrl: string | null;
  name: string | undefined;
  size: number | undefined;
};

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
 * A browser tab the composer references by identity, not by capturing its
 * content - the coding agent reads it live through `page.attachTab({tabId})`.
 * `path` is the durable `browser-tab:<tabId>` token (mirrors how Terminal's
 * path is `terminal:<epicId>/<terminalId>`, not its title), so a rename never
 * changes the identity the attachment carries. `label` is the tab's title at
 * mention time and `url` its address at mention time, both display-only
 * (the composer live decorator's tooltip fallback when the tab is gone),
 * since the token round-trips through `tabId` alone. `description` is unused
 * for this variant - kept at `""` only because `MentionAttachment` requires
 * the field on every member.
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
export type Attachment =
  | ImageAttachment
  | MentionAttachment
  | BrowserAnnotationRecord;

/**
 * Full, untruncated preview content for a picker row - the side preview panel
 * reads this instead of the (possibly CSS-truncated) `label`/`detail`/
 * `description` the row renders.
 *
 * `kind: "path"` covers real filesystem paths (file/folder/worktree): `tree`
 * is the breadcrumb hierarchy and `footer` is the muted line underneath it
 * (the absolute path for file/folder; the branch name for a worktree, since
 * its tree already IS the absolute path). `kind: "text"` covers everything
 * else (git branch/commit, epic, artifact, chat, slash) - `secondary` carries
 * a second value only for kinds that have one (parent epic title, commit
 * subject), otherwise `null`. `mono` is set at the source (git hashes/branch
 * names) rather than inferred from `primary`'s shape, so a title containing a
 * slash (e.g. "UI/UX") never gets mistaken for a path.
 */
export type MentionPreview =
  | {
      readonly kind: "path";
      readonly tree: MentionPathTree;
      readonly footer: { readonly text: string; readonly mono: boolean } | null;
    }
  | {
      readonly kind: "text";
      readonly primary: string;
      readonly secondary: string | null;
      readonly mono: boolean;
    }
  | {
      /**
       * A labelled fact card, for rows whose useful preview is several small
       * values rather than one string - the PR/issue rows, whose panel shows
       * the reference, state, author and last update together. `facts` renders
       * in order and is expected to be short; a fact with nothing to say is
       * omitted at the source rather than rendered blank.
       */
      readonly kind: "card";
      readonly title: string;
      readonly subtitle: string;
      readonly facts: ReadonlyArray<MentionPreviewFact>;
    };

export interface MentionPreviewFact {
  readonly label: string;
  readonly value: string;
}

export type ProviderSlashCommand = GuiAgentCommandOption & {
  source: "provider";
  preview: MentionPreview;
};

export type SlashCommand = ProviderSlashCommand;

/**
 * Character that opened a slash picker, or that a raw-text prompt led with.
 * Purely what the user pressed - it does not narrow the catalog. The menu echoes
 * it so a row picked with `$` does not read as `/name`, and the chip keeps it for
 * the same reason; translating a skill into the form a provider expects (Codex
 * takes `$name`, everything else `/name`) is the harness layer's job.
 *
 * Lives here rather than beside the picker so the text-to-chip converters in
 * `tiptap-json-content.ts` can name it without importing from the editor.
 */
export type SlashCommandTrigger = "/" | "$";
