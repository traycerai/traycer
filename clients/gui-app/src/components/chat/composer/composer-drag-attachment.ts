import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import { epicArtifactMentionToken } from "@traycer/protocol/host/epic/unary-schemas";
import {
  ACTIVE_AGENT_DND_TYPE,
  CHAT_ARTIFACT_DND_TYPE,
  GIT_DIFF_TILE_DND_TYPE,
  SIDEBAR_NODE_DND_TYPE,
  WORKSPACE_FILE_DND_TYPE,
  WORKSPACE_FOLDER_DND_TYPE,
  type EpicCanvasDragSourceData,
} from "@/components/epic-canvas/dnd/dnd";
import { taskMentionTitleFromRawTitle } from "@/lib/composer/mentions/task-mention-helpers";
import { mentionPathFields } from "@/lib/composer/mentions/search-path-suggestions";
import type {
  EntityMentionAttachment,
  FileMentionAttachment,
  MentionAttachment,
  PathKind,
} from "@/lib/composer/types";
import { epicTreeRecordForNodeId } from "@/lib/epic-selectors";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import { getBasename } from "@/lib/path/cross-platform-path";

type EntityContextType = "chat" | "terminal-agent" | EpicArtifactKind;

function entityMentionAttachment(args: {
  readonly contextType: EntityContextType;
  readonly epicId: string;
  readonly entityId: string;
  readonly label: string;
  readonly description: string;
}): EntityMentionAttachment {
  const artifactType =
    args.contextType === "chat" || args.contextType === "terminal-agent"
      ? null
      : args.contextType;
  let path: string;
  if (args.contextType === "chat") {
    path = `chat:${args.epicId}/${args.entityId}`;
  } else if (args.contextType === "terminal-agent") {
    path = `terminal-agent:${args.epicId}/${args.entityId}`;
  } else {
    path = epicArtifactMentionToken(
      args.contextType,
      args.epicId,
      args.entityId,
    );
  }
  return {
    kind: "mention",
    contextType: args.contextType,
    path,
    pathKind: null,
    relPath: null,
    absolutePath: null,
    workspacePath: null,
    label: args.label,
    description: args.description,
    epicId: args.epicId,
    artifactId: artifactType === null ? null : args.entityId,
    artifactType,
    chatId: args.contextType === "chat" ? args.entityId : null,
    terminalAgentId:
      args.contextType === "terminal-agent" ? args.entityId : null,
    status: null,
  };
}

function epicTitle(epicId: string): string {
  const handle = getOpenEpicRegistry().peek(epicId);
  if (handle === null) return "";
  return taskMentionTitleFromRawTitle(handle.store.getState().epic.title);
}

function sidebarNodeMention(
  source: Extract<
    EpicCanvasDragSourceData,
    { readonly kind: typeof SIDEBAR_NODE_DND_TYPE }
  >,
  targetHostId: string,
): MentionAttachment | null {
  const handle = getOpenEpicRegistry().peek(source.epicId);
  if (handle === null) return null;
  const state = handle.store.getState();
  const record = epicTreeRecordForNodeId(state, source.nodeId, targetHostId);
  if (record === null || record.hostId !== targetHostId) return null;
  if (
    record.type === "terminal-agent" &&
    Object.hasOwn(state.tuiAgents.byId, source.nodeId) &&
    state.tuiAgents.byId[source.nodeId].harnessId === "cursor"
  ) {
    return null;
  }
  return entityMentionAttachment({
    contextType: record.type,
    epicId: source.epicId,
    entityId: record.id,
    label: record.name,
    description: taskMentionTitleFromRawTitle(state.epic.title),
  });
}

function pathMentionAttachment(args: {
  readonly pathKind: PathKind;
  readonly workspacePath: string;
  readonly relPath: string;
  readonly label: string;
}): FileMentionAttachment {
  const fields = mentionPathFields(
    args.workspacePath,
    args.relPath,
    args.pathKind,
  );
  return {
    kind: "mention",
    contextType: args.pathKind,
    path: fields.relPath,
    pathKind: args.pathKind,
    relPath: fields.relPath,
    absolutePath: fields.absolutePath,
    workspacePath: args.workspacePath,
    label: args.label,
    description: fields.description,
  };
}

/** Convert a root-DnD source into the same attachment shape inserted by @. */
export function mentionAttachmentFromDragSource(
  source: EpicCanvasDragSourceData,
  targetHostId: string,
): MentionAttachment | null {
  if (source.kind === SIDEBAR_NODE_DND_TYPE) {
    return sidebarNodeMention(source, targetHostId);
  }
  if (source.kind === WORKSPACE_FILE_DND_TYPE) {
    if (source.ref.hostId !== targetHostId) return null;
    return pathMentionAttachment({
      pathKind: "file",
      workspacePath: source.ref.workspacePath,
      relPath: source.ref.filePath,
      label: source.ref.name,
    });
  }
  if (source.kind === WORKSPACE_FOLDER_DND_TYPE) {
    if (source.hostId !== targetHostId) return null;
    return pathMentionAttachment({
      pathKind: "folder",
      workspacePath: source.workspacePath,
      relPath: source.folderPath,
      label: source.name,
    });
  }
  if (source.kind === GIT_DIFF_TILE_DND_TYPE) {
    if (
      source.tile.hostId !== targetHostId ||
      source.tile.diff.kind !== "file"
    ) {
      return null;
    }
    return pathMentionAttachment({
      pathKind: "file",
      workspacePath: source.tile.diff.runningDir,
      relPath: source.tile.diff.filePath,
      label: getBasename(source.tile.diff.filePath),
    });
  }
  if (source.kind === CHAT_ARTIFACT_DND_TYPE) {
    if (source.artifact.hostId !== targetHostId) return null;
    return entityMentionAttachment({
      contextType: source.artifact.type,
      epicId: source.epicId,
      entityId: source.artifact.id,
      label: source.artifact.name,
      description: epicTitle(source.epicId),
    });
  }
  if (source.kind === ACTIVE_AGENT_DND_TYPE) {
    if (
      source.agent.hostId !== targetHostId ||
      source.agent.harnessId === "cursor"
    ) {
      return null;
    }
    return entityMentionAttachment({
      contextType: source.agent.type,
      epicId: source.epicId,
      entityId: source.agent.id,
      label: source.agent.name,
      description: epicTitle(source.epicId),
    });
  }
  // Artifact tabs, raw terminal sessions, and panel-rail chrome are not
  // readable message context and intentionally stay non-attachable.
  return null;
}
