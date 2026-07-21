import { type EpicArtifactKind } from "@traycer/protocol/common/registry";
import { basenameOfPath } from "@/lib/path";

// Set membership beats `epicArtifactKindSchema.safeParse(value).success`
// on the per-render mention paths (`createLegacyMentionAttachment` runs
// for every mention segment in every chat-message render).
const EPIC_ARTIFACT_KINDS: ReadonlySet<string> = new Set<EpicArtifactKind>([
  "spec",
  "ticket",
  "story",
  "review",
]);
import type {
  EntityMentionAttachment,
  MentionAttachment,
  PathKind,
} from "@/lib/composer/types";

export function inferPathKind(path: string): PathKind {
  return path.endsWith("/") ? "folder" : "file";
}

export function createLegacyMentionAttachment(path: string): MentionAttachment {
  const entityMention = legacyEntityMentionAttachment(path);
  if (entityMention !== null) return entityMention;
  const pathKind = inferPathKind(path);
  return {
    kind: "mention",
    contextType: pathKind,
    path,
    pathKind,
    relPath: path,
    absolutePath: null,
    workspacePath: null,
    label: basenameOfPath(path) || path,
    description: "",
  };
}

function legacyEntityMentionAttachment(
  path: string,
): EntityMentionAttachment | null {
  const epicMatch = path.match(/^epic:([^/\s]+)$/u);
  if (epicMatch !== null) {
    const epicId = epicMatch[1];
    return {
      kind: "mention",
      contextType: "epic",
      path,
      pathKind: null,
      relPath: null,
      absolutePath: null,
      workspacePath: null,
      label: epicId,
      description: "",
      epicId,
      artifactId: null,
      artifactType: null,
      chatId: null,
      terminalAgentId: null,
      status: null,
    };
  }

  // `chat:` is the durable reference syntax for a chat-interface Agent and stays
  // parseable indefinitely - persisted references are never rewritten.
  const chatMatch = path.match(/^chat:([^/\s]+)\/([^\s]+)$/u);
  if (chatMatch !== null) {
    const epicId = chatMatch[1];
    const chatId = chatMatch[2];
    return {
      kind: "mention",
      contextType: "chat",
      path,
      pathKind: null,
      relPath: null,
      absolutePath: null,
      workspacePath: null,
      label: chatId,
      description: "",
      epicId,
      artifactId: null,
      artifactType: null,
      chatId,
      terminalAgentId: null,
      status: null,
    };
  }

  const terminalAgentMatch = path.match(
    /^terminal-agent:([^/\s]+)\/([^\s]+)$/u,
  );
  if (terminalAgentMatch !== null) {
    const epicId = terminalAgentMatch[1];
    const terminalAgentId = terminalAgentMatch[2];
    return {
      kind: "mention",
      contextType: "terminal-agent",
      path,
      pathKind: null,
      relPath: null,
      absolutePath: null,
      workspacePath: null,
      label: terminalAgentId,
      description: "",
      epicId,
      artifactId: null,
      artifactType: null,
      chatId: null,
      terminalAgentId,
      status: null,
    };
  }

  const artifactMatch = path.match(
    /^(spec|ticket|story|review):([^/\s]+)\/([^\s]+)$/u,
  );
  if (artifactMatch === null) return null;
  const artifactType = artifactMatch[1];
  if (!isEpicArtifactKind(artifactType)) return null;
  const epicId = artifactMatch[2];
  const artifactId = artifactMatch[3];
  return {
    kind: "mention",
    contextType: artifactType,
    path,
    pathKind: null,
    relPath: null,
    absolutePath: null,
    workspacePath: null,
    label: artifactId,
    description: "",
    epicId,
    artifactId,
    artifactType,
    chatId: null,
    terminalAgentId: null,
    status: null,
  };
}

function isEpicArtifactKind(value: string): value is EpicArtifactKind {
  return EPIC_ARTIFACT_KINDS.has(value);
}
