import type {
  GuiAgentCommandOption,
  EpicMentionSuggestion,
  WorkspaceMentionGitType,
  WorkspaceMentionSuggestion,
} from "@traycer/protocol/host/index";
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import type { TuiHarnessId } from "@traycer/protocol/persistence/epic/schemas";
import type { MentionPathTree } from "@/lib/path";

export type PathKind = "file" | "folder";
export type EntityMentionContextType =
  "epic" | "chat" | "terminal-agent" | EpicArtifactKind | "user";
export type MentionContextType =
  PathKind | "git" | "worktree" | EntityMentionContextType;

export type ComposerPromptSegment =
  { type: "text"; text: string } | { type: "mention"; path: string };

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
  readonly agentInterface: AgentMentionInterface;
  /**
   * Whether this Agent's RUNTIME supports agent-to-agent delivery at all - the
   * surface/harness arm of the host's send gate (`canParticipateInA2A`). It is
   * deliberately NOT a claim of actual routability: the host additionally
   * requires the receiver to be same-user and host-local (`agent.list`'s
   * `capabilities.sendMessage` = `sameUser && isLocal && canParticipateInA2A`),
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
  EpicChatMentionEntry | EpicTerminalAgentMentionEntry;

export type EpicMentionEntry = EpicMentionSuggestion | EpicAgentMentionEntry;
export type MentionSuggestionEntry = WorkspaceEntry | EpicMentionEntry;

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
  status: string | number | null;
};

export type MentionAttachment =
  | FileMentionAttachment
  | WorktreeMentionAttachment
  | GitMentionAttachment
  | EntityMentionAttachment;
export type Attachment = ImageAttachment | MentionAttachment;

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
    };

export type ProviderSlashCommand = GuiAgentCommandOption & {
  source: "provider";
  preview: MentionPreview;
};

export type SlashCommand = ProviderSlashCommand;
