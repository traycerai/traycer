import type {
  ChatMessage as ChatMessageModel,
  MessageSegment,
} from "@/stores/composer/chat-store";

export function makeMessages(count: number): ReadonlyArray<ChatMessageModel> {
  return Array.from({ length: count }, (_unused, index) =>
    makeMessage(index, "user"),
  );
}

export function makeMessage(
  index: number,
  role: ChatMessageModel["role"],
): ChatMessageModel {
  return makeMessageAt(index, role, index);
}

export function makeMessageAt(
  index: number,
  role: ChatMessageModel["role"],
  createdAt: number,
): ChatMessageModel {
  const id = `message-${index}`;
  const content = role === "user" ? `User message ${index}` : "";
  return {
    id,
    role,
    content,
    segments: [],
    structuredContent: null,
    attachments: [],
    settings: null,
    createdAt,
    completedAt: null,
    stopped: null,
    persistentMessageId: null,
    senderLabel: null,
    assistantMeta: null,
    statusLabel: null,
    agentSenderInfo: null,
    agentMessage: null,
    runState: null,
    sessionAnchor: null,
    steerBadge: null,
  };
}

export function makeAssistantMessage(
  id: string,
  activityId: string,
): ChatMessageModel {
  const segment: MessageSegment = {
    id: `${activityId}:command`,
    kind: "command",
    command: "echo hi",
    cwd: null,
    exitCode: 0,
    isStreaming: false,
    endState: null,
    progress: null,
    startedAt: 0,
    parentId: null,
  };
  return {
    id,
    role: "assistant",
    content: "",
    segments: [segment],
    structuredContent: null,
    attachments: [],
    settings: null,
    createdAt: 1,
    completedAt: null,
    stopped: null,
    persistentMessageId: null,
    senderLabel: null,
    assistantMeta: null,
    statusLabel: null,
    agentSenderInfo: null,
    agentMessage: null,
    runState: null,
    sessionAnchor: null,
    steerBadge: null,
  };
}
