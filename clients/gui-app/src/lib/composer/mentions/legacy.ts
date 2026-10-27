import {
  artifactKindFromMentionContextType,
  artifactMentionContextType,
} from "@traycer/protocol/common/composer-mention-attrs";
import { basenameOfPath } from "@/lib/path";
import type { MentionAttachment, PathKind } from "@/lib/composer/types";

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

function legacyEntityMentionAttachment(path: string): MentionAttachment | null {
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
      terminalId: null,
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
      terminalId: null,
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
      terminalId: null,
      status: null,
    };
  }

  // `terminal:` names the shell itself, not an Agent - see `ContextType.Terminal`.
  // Order against the `terminal-agent:` branch above does not matter: each
  // pattern is separately anchored, so `@terminal-agent:…` cannot satisfy this
  // one however the branches are arranged.
  const terminalMatch = path.match(/^terminal:([^/\s]+)\/([^\s]+)$/u);
  if (terminalMatch !== null) {
    const epicId = terminalMatch[1];
    const terminalId = terminalMatch[2];
    return {
      kind: "mention",
      contextType: "terminal",
      path,
      pathKind: null,
      relPath: null,
      absolutePath: null,
      workspacePath: null,
      label: terminalId,
      description: "",
      epicId,
      artifactId: null,
      artifactType: null,
      chatId: null,
      terminalAgentId: null,
      terminalId,
      status: null,
    };
  }

  // `@browser-tab:<title> [tabId=...]` (see `formatMentionForLLMQuery`'s
  // `ContextType.BrowserTab` arm) - only the title survives into `path`
  // (`MENTION_TOKEN_REGEX` stops at the first space, so a multi-word title
  // loses its tail here same as it already does for `@agent:`/`@terminal:`).
  // `tabId` is genuinely unrecoverable from text alone when the attachments
  // array is missing, so this degrades to a reference-only chip that carries
  // no live identity - the composer/sent-message favicon branches already
  // treat an empty `tabId` as "not resolvable" and fall back to the globe icon.
  const browserTabMatch = path.match(/^browser-tab:([^/\s]+)$/u);
  if (browserTabMatch !== null) {
    const title = browserTabMatch[1];
    return {
      kind: "mention",
      contextType: "browser-tab",
      path,
      pathKind: null,
      relPath: null,
      absolutePath: null,
      workspacePath: null,
      label: title,
      description: "",
      tabId: "",
      sessionId: "",
      url: "",
    };
  }

  // The prefix is the kind's mention context type, which is how the token was
  // minted (`epicArtifactMentionToken`); a file artifact reads `file-artifact`.
  const artifactMatch = path.match(
    /^(spec|ticket|story|review|html|canvas|file-artifact):([^/\s]+)\/([^\s]+)$/u,
  );
  if (artifactMatch === null) return null;
  const contextType = artifactMatch[1];
  const artifactType = artifactKindFromMentionContextType(contextType);
  if (artifactType === null) return null;
  const epicId = artifactMatch[2];
  const artifactId = artifactMatch[3];
  return {
    kind: "mention",
    contextType: artifactMentionContextType(artifactType),
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
    terminalId: null,
    status: null,
  };
}
