import { sessionWorkspaceSnapshotSchema } from "@traycer/protocol/common/workspace-association";
import { guiHarnessIdSchema } from "@traycer/protocol/persistence/epic/foundation";
import { z } from "zod";

/**
 * Message senders + per-harness chat-session anchors.
 *
 * `userMessageSenderSchema` discriminates a real user from an agent-as-user
 * sender (agent-to-agent messaging). Anchor schemas pin a chat to its
 * upstream harness session so the host can resume / rehydrate the right
 * CLI thread from cloud-replicated history.
 */

export const userSenderSchema = z.object({
  type: z.literal("user"),
  userId: z.string(),
});
export type UserSender = z.infer<typeof userSenderSchema>;

export const agentSenderSchema = z.object({
  type: z.literal("agent"),
  harnessId: guiHarnessIdSchema,
  agentId: z.string(),
  displayName: z.string().nullable(),
  /**
   * Reply contract for agent-as-user senders. When the sending agent set
   * `expectReply=true` on its `agent.sendMessage` call, this carries the
   * broker-minted thread id the receiver must echo back. One-shot deliveries,
   * final replies that close a thread, and assistant turns use
   * `{ expectsReply: false }` — the field is only meaningful on user
   * messages with `type: "agent"`. The receiving GUI surfaces reply-expected
   * messages in the "how to reply" footer (`traycer agent send …
   * --response-id <id>` closes the thread when replying with
   * `expectReply=false`).
   */
  reply: z
    .discriminatedUnion("expectsReply", [
      z.object({
        expectsReply: z.literal(true),
        responseId: z.string(),
      }),
      z.object({
        expectsReply: z.literal(false),
      }),
    ])
    .default({ expectsReply: false }),
});
export type AgentSender = z.infer<typeof agentSenderSchema>;

export const userMessageSenderSchema = z.discriminatedUnion("type", [
  userSenderSchema,
  agentSenderSchema,
]);
export type UserMessageSender = z.infer<typeof userMessageSenderSchema>;
export type AssistantMessageSender = z.infer<typeof agentSenderSchema>;

export const activeSessionChainSchema = z.object({
  harnessId: guiHarnessIdSchema,
  sessionId: z.string(),
  // Historical workspace state for resume/fork decisions. Runtime turns must
  // use a fresh ProviderWorkspace derived from the current visible binding.
  sessionWorkspaceSnapshot: sessionWorkspaceSnapshotSchema,
  // The live session's fake-context seed (see the anchor-field comment below).
  // The chain authorizes plain resumes, so it carries the seed those resumes
  // re-ensure against; the per-message anchors remain the authority for forks,
  // which outlive the chain (an edit-trim nulls it). Written on session
  // created/resumed from the turn's routing value, so it never waits on the
  // later user-message anchor event — closing the crash window where a fresh
  // seeded session has a chain but no anchor yet.
  coveredUntilMessageId: z.string().nullable().default(null),
});
export type ActiveChain = z.infer<typeof activeSessionChainSchema>;

// `coveredUntilMessageId` (on every anchor below) records the last chat message
// covered by the fake-context seed file written when this session's lineage root
// was seeded; the file's content is a pure function of the prefix up to and
// including that message. `null` unifies "no seed context ever existed" — a
// session that started the chat (empty prefix, no prelude) and a legacy anchor
// persisted before this field existed. The `.default(null)` lets those old
// anchors parse (matching the legacy-field precedent above).
export const claudeChatSessionAnchorSchema = z.object({
  harnessId: z.literal("claude"),
  hostId: z.string(),
  sessionId: z.string(),
  sessionWorkspaceSnapshot: sessionWorkspaceSnapshotSchema,
  claudeMessageUuid: z.string(),
  createdAt: z.number(),
  coveredUntilMessageId: z.string().nullable().default(null),
});
export type ClaudeChatSessionAnchor = z.infer<
  typeof claudeChatSessionAnchorSchema
>;

export const codexChatSessionAnchorSchema = z.object({
  harnessId: z.literal("codex"),
  hostId: z.string(),
  sessionId: z.string(),
  sessionWorkspaceSnapshot: sessionWorkspaceSnapshotSchema,
  codexTurnId: z.string(),
  codexUserMessageId: z.string().nullable(),
  createdAt: z.number(),
  coveredUntilMessageId: z.string().nullable().default(null),
});
export type CodexChatSessionAnchor = z.infer<
  typeof codexChatSessionAnchorSchema
>;

export const openCodeChatSessionAnchorSchema = z.object({
  harnessId: z.literal("opencode"),
  hostId: z.string(),
  sessionId: z.string(),
  sessionWorkspaceSnapshot: sessionWorkspaceSnapshotSchema,
  opencodeUserMessageId: z.string(),
  createdAt: z.number(),
  coveredUntilMessageId: z.string().nullable().default(null),
});
export type OpenCodeChatSessionAnchor = z.infer<
  typeof openCodeChatSessionAnchorSchema
>;

export const cursorChatSessionAnchorSchema = z.object({
  harnessId: z.literal("cursor"),
  hostId: z.string(),
  sessionId: z.string(),
  sessionWorkspaceSnapshot: sessionWorkspaceSnapshotSchema,
  cursorRunId: z.string().nullable(),
  createdAt: z.number(),
  coveredUntilMessageId: z.string().nullable().default(null),
});
export type CursorChatSessionAnchor = z.infer<
  typeof cursorChatSessionAnchorSchema
>;

export const traycerChatSessionAnchorSchema = z.object({
  harnessId: z.literal("traycer"),
  hostId: z.string(),
  sessionId: z.string(),
  sessionWorkspaceSnapshot: sessionWorkspaceSnapshotSchema,
  opencodeUserMessageId: z.string(),
  createdAt: z.number(),
  coveredUntilMessageId: z.string().nullable().default(null),
});
export type TraycerChatSessionAnchor = z.infer<
  typeof traycerChatSessionAnchorSchema
>;

export const openRouterChatSessionAnchorSchema = z.object({
  harnessId: z.literal("openrouter"),
  hostId: z.string(),
  sessionId: z.string(),
  sessionWorkspaceSnapshot: sessionWorkspaceSnapshotSchema,
  opencodeUserMessageId: z.string(),
  createdAt: z.number(),
  coveredUntilMessageId: z.string().nullable().default(null),
});
export type OpenRouterChatSessionAnchor = z.infer<
  typeof openRouterChatSessionAnchorSchema
>;

// Grok (ACP) resumes at session granularity only — `session/load` reloads the
// whole ACP session, with no per-message truncation/fork point — so the anchor
// carries just the ACP session id (no provider-native user-message id like the
// others). `sessionId` is that ACP session id.
export const grokChatSessionAnchorSchema = z.object({
  harnessId: z.literal("grok"),
  hostId: z.string(),
  sessionId: z.string(),
  sessionWorkspaceSnapshot: sessionWorkspaceSnapshotSchema,
  createdAt: z.number(),
  coveredUntilMessageId: z.string().nullable().default(null),
});
export type GrokChatSessionAnchor = z.infer<typeof grokChatSessionAnchorSchema>;

// Qwen (ACP) resumes at session granularity only — `session/load` reloads the
// whole ACP session, with no per-message truncation/fork point — so the anchor
// carries just the ACP session id. `sessionId` is that ACP session id.
export const qwenChatSessionAnchorSchema = z.object({
  harnessId: z.literal("qwen"),
  hostId: z.string(),
  sessionId: z.string(),
  sessionWorkspaceSnapshot: sessionWorkspaceSnapshotSchema,
  createdAt: z.number(),
  coveredUntilMessageId: z.string().nullable().default(null),
});
export type QwenChatSessionAnchor = z.infer<typeof qwenChatSessionAnchorSchema>;
// Kiro (ACP) resumes at session granularity only — `session/load` reloads the
// whole ACP session, with no per-message truncation/fork point.
export const kiroChatSessionAnchorSchema = z.object({
  harnessId: z.literal("kiro"),
  hostId: z.string(),
  sessionId: z.string(),
  sessionWorkspaceSnapshot: sessionWorkspaceSnapshotSchema,
  createdAt: z.number(),
  coveredUntilMessageId: z.string().nullable().default(null),
});
export type KiroChatSessionAnchor = z.infer<typeof kiroChatSessionAnchorSchema>;

export const droidChatSessionAnchorSchema = z.object({
  harnessId: z.literal("droid"),
  hostId: z.string(),
  sessionId: z.string(),
  sessionWorkspaceSnapshot: sessionWorkspaceSnapshotSchema,
  createdAt: z.number(),
  coveredUntilMessageId: z.string().nullable().default(null),
});
export type DroidChatSessionAnchor = z.infer<
  typeof droidChatSessionAnchorSchema
>;

// Kimi (ACP) resumes at session granularity only — `session/load` reloads the
// whole ACP session, with no per-message truncation/fork point — so the anchor
// carries just the ACP session id. `sessionId` is that ACP session id.
export const kimiChatSessionAnchorSchema = z.object({
  harnessId: z.literal("kimi"),
  hostId: z.string(),
  sessionId: z.string(),
  sessionWorkspaceSnapshot: sessionWorkspaceSnapshotSchema,
  createdAt: z.number(),
  coveredUntilMessageId: z.string().nullable().default(null),
});
export type KimiChatSessionAnchor = z.infer<typeof kimiChatSessionAnchorSchema>;

// Copilot (ACP) resumes at session granularity only — `session/load` reloads
// the whole ACP session, with no per-message truncation/fork point. `sessionId`
// is the ACP session id.
export const copilotChatSessionAnchorSchema = z.object({
  harnessId: z.literal("copilot"),
  hostId: z.string(),
  sessionId: z.string(),
  sessionWorkspaceSnapshot: sessionWorkspaceSnapshotSchema,
  createdAt: z.number(),
  coveredUntilMessageId: z.string().nullable().default(null),
});
export type CopilotChatSessionAnchor = z.infer<
  typeof copilotChatSessionAnchorSchema
>;

export const kilocodeChatSessionAnchorSchema = z.object({
  harnessId: z.literal("kilocode"),
  hostId: z.string(),
  sessionId: z.string(),
  sessionWorkspaceSnapshot: sessionWorkspaceSnapshotSchema,
  createdAt: z.number(),
  coveredUntilMessageId: z.string().nullable().default(null),
});
export type KilocodeChatSessionAnchor = z.infer<
  typeof kilocodeChatSessionAnchorSchema
>;

// Amp resumes at thread granularity only — `execute`'s `options.continue`
// reloads the whole Amp thread, with no per-message truncation/fork point.
// `sessionId` is the Amp thread id.
export const ampChatSessionAnchorSchema = z.object({
  harnessId: z.literal("amp"),
  hostId: z.string(),
  sessionId: z.string(),
  sessionWorkspaceSnapshot: sessionWorkspaceSnapshotSchema,
  createdAt: z.number(),
  coveredUntilMessageId: z.string().nullable().default(null),
});
export type AmpChatSessionAnchor = z.infer<typeof ampChatSessionAnchorSchema>;

export const chatSessionAnchorSchema = z.discriminatedUnion("harnessId", [
  claudeChatSessionAnchorSchema,
  codexChatSessionAnchorSchema,
  openCodeChatSessionAnchorSchema,
  cursorChatSessionAnchorSchema,
  traycerChatSessionAnchorSchema,
  openRouterChatSessionAnchorSchema,
  grokChatSessionAnchorSchema,
  qwenChatSessionAnchorSchema,
  kiroChatSessionAnchorSchema,
  droidChatSessionAnchorSchema,
  kimiChatSessionAnchorSchema,
  copilotChatSessionAnchorSchema,
  kilocodeChatSessionAnchorSchema,
  ampChatSessionAnchorSchema,
]);
export type ChatSessionAnchor = z.infer<typeof chatSessionAnchorSchema>;
