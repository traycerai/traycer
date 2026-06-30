import type {
  GuiAgentCommandOption,
  EpicMentionSuggestion,
  WorkspaceMentionGitType,
  WorkspaceMentionSuggestion,
} from "@traycer/protocol/host/index";
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";

export type PathKind = "file" | "folder";
export type EntityMentionContextType =
  "epic" | "chat" | EpicArtifactKind | "user";
export type MentionContextType =
  PathKind | "git" | "worktree" | EntityMentionContextType;

export type ComposerPromptSegment =
  { type: "text"; text: string } | { type: "mention"; path: string };

export type WorkspaceEntry = WorkspaceMentionSuggestion;
export interface EpicChatMentionEntry {
  readonly kind: "epic-chat";
  readonly id: string;
  readonly token: string;
  readonly epicId: string;
  readonly epicTitle: string;
  readonly chatId: string;
  readonly label: string;
  readonly description: string;
  readonly parentId: string | null;
  readonly updatedAt: number;
}

export type EpicMentionEntry = EpicMentionSuggestion | EpicChatMentionEntry;
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
  status: string | number | null;
};

export type MentionAttachment =
  | FileMentionAttachment
  | WorktreeMentionAttachment
  | GitMentionAttachment
  | EntityMentionAttachment;
export type Attachment = ImageAttachment | MentionAttachment;

export type ProviderSlashCommand = GuiAgentCommandOption & {
  source: "provider";
};

export type SlashCommand = ProviderSlashCommand;
