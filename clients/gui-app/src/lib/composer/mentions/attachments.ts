import type {
  BrowserTabMentionAttachment,
  BrowserTabMentionEntry,
  EntityMentionAttachment,
  GitMentionAttachment,
  MentionAttachment,
  MentionSuggestionEntry,
  WorkspaceEntry,
  WorktreeMentionAttachment,
} from "@/lib/composer/types";
import { createLegacyMentionAttachment, inferPathKind } from "./legacy";

export { createLegacyMentionAttachment, inferPathKind };

export function mentionAttachmentFromSuggestion(
  entry: MentionSuggestionEntry,
): MentionAttachment | null {
  if (entry.kind === "git") return gitMentionAttachmentFromSuggestion(entry);
  if (entry.kind === "worktree") {
    return worktreeMentionAttachmentFromSuggestion(entry);
  }
  if (entry.kind === "browser-tab") {
    return browserTabMentionAttachmentFromSuggestion(entry);
  }
  if (
    entry.kind === "epic" ||
    entry.kind === "epic-artifact" ||
    entry.kind === "epic-chat" ||
    entry.kind === "epic-terminal-agent" ||
    entry.kind === "epic-terminal"
  ) {
    return entityMentionAttachmentFromSuggestion(entry);
  }
  return {
    kind: "mention",
    contextType: entry.kind,
    path: entry.relPath,
    pathKind: entry.kind,
    relPath: entry.relPath,
    absolutePath: entry.absolutePath,
    workspacePath: entry.workspacePath,
    label: entry.label,
    description: entry.description,
  };
}

function entityMentionAttachmentFromSuggestion(
  entry: Extract<
    MentionSuggestionEntry,
    {
      kind:
        | "epic"
        | "epic-artifact"
        | "epic-chat"
        | "epic-terminal-agent"
        | "epic-terminal";
    }
  >,
): EntityMentionAttachment {
  if (entry.kind === "epic") {
    return {
      kind: "mention",
      contextType: "epic",
      path: entry.token,
      pathKind: null,
      relPath: null,
      absolutePath: null,
      workspacePath: null,
      label: entry.label,
      description: entry.description,
      epicId: entry.epicId,
      artifactId: null,
      artifactType: null,
      chatId: null,
      terminalAgentId: null,
      terminalId: null,
      status: entry.status,
    };
  }

  if (entry.kind === "epic-chat") {
    return {
      kind: "mention",
      contextType: "chat",
      path: entry.token,
      pathKind: null,
      relPath: null,
      absolutePath: null,
      workspacePath: null,
      label: entry.label,
      description: entry.description,
      epicId: entry.epicId,
      artifactId: null,
      artifactType: null,
      chatId: entry.chatId,
      terminalAgentId: null,
      terminalId: null,
      status: null,
    };
  }

  if (entry.kind === "epic-terminal-agent") {
    return {
      kind: "mention",
      contextType: "terminal-agent",
      path: entry.token,
      pathKind: null,
      relPath: null,
      absolutePath: null,
      workspacePath: null,
      label: entry.label,
      description: entry.description,
      epicId: entry.epicId,
      artifactId: null,
      artifactType: null,
      chatId: null,
      terminalAgentId: entry.terminalAgentId,
      terminalId: null,
      status: null,
    };
  }

  if (entry.kind === "epic-terminal") {
    return {
      kind: "mention",
      contextType: "terminal",
      path: entry.token,
      pathKind: null,
      relPath: null,
      absolutePath: null,
      workspacePath: null,
      label: entry.label,
      description: entry.description,
      epicId: entry.epicId,
      artifactId: null,
      artifactType: null,
      chatId: null,
      terminalAgentId: null,
      terminalId: entry.terminalId,
      status: null,
    };
  }

  return {
    kind: "mention",
    contextType: entry.artifactType,
    path: entry.token,
    pathKind: null,
    relPath: null,
    absolutePath: null,
    workspacePath: null,
    label: entry.label,
    description: entry.description,
    epicId: entry.epicId,
    artifactId: entry.artifactId,
    artifactType: entry.artifactType,
    chatId: null,
    terminalAgentId: null,
    terminalId: null,
    status: entry.status,
  };
}

function worktreeMentionAttachmentFromSuggestion(
  entry: Extract<WorkspaceEntry, { kind: "worktree" }>,
): WorktreeMentionAttachment {
  return {
    kind: "mention",
    contextType: "worktree",
    path: entry.worktreePath,
    pathKind: null,
    relPath: null,
    absolutePath: entry.worktreePath,
    workspacePath: entry.workspacePath,
    label: entry.label,
    description: entry.description,
    worktreePath: entry.worktreePath,
    branch: entry.branch,
    isMain: entry.isMain,
  };
}

function browserTabMentionAttachmentFromSuggestion(
  entry: BrowserTabMentionEntry,
): BrowserTabMentionAttachment {
  return {
    kind: "mention",
    contextType: "browser-tab",
    path: `browser-tab:${entry.tabId}`,
    pathKind: null,
    relPath: null,
    absolutePath: null,
    workspacePath: null,
    label: entry.label,
    // Dead field kept only because `MentionAttachment` requires it - the sent
    // message chip renders a static Globe2 icon and no consumer reads this
    // for browser-tab entries anymore (see FIX 3 in chat-user-message-content).
    description: "",
    tabId: entry.tabId,
    sessionId: entry.sessionId,
    url: entry.url,
  };
}

function gitMentionAttachmentFromSuggestion(
  entry: Extract<WorkspaceEntry, { kind: "git" }>,
): GitMentionAttachment {
  return {
    kind: "mention",
    contextType: "git",
    path: gitMentionPath(entry),
    pathKind: null,
    relPath: null,
    absolutePath: null,
    workspacePath: entry.workspacePath,
    label: entry.label,
    description: entry.description,
    gitType: entry.gitType,
    branchName: entry.branchName,
    commitHash: entry.commitHash,
  };
}

function gitMentionPath(
  entry: Extract<WorkspaceEntry, { kind: "git" }>,
): string {
  if (entry.gitType === "against_uncommitted_changes") {
    return "git:working-tree";
  }
  if (entry.gitType === "against_commit") {
    return `git:commit:${entry.commitHash}`;
  }
  return `git:branch:${entry.branchName}`;
}
