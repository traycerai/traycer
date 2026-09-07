import { sessionWorkspaceSnapshotSchema } from "@traycer/protocol/common/workspace-association";
import {
  guiHarnessIdSchema,
  guiHarnessIdSchemaPreReasonix,
} from "@traycer/protocol/persistence/epic/foundation";
import { z } from "zod";

/** Message senders + per-harness chat-session anchors. */

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
   * Reply contract for agent-as-user senders.
   * When the sending agent set `expectReply=true` on its `agent.sendMessage` call, this carries the broker-minted thread id the receiver must echo back.
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
  inReplyTo: z.string().nullable().default(null),
});
export type AgentSender = z.infer<typeof agentSenderSchema>;

export const userMessageSenderSchema = z.discriminatedUnion("type", [
  userSenderSchema,
  agentSenderSchema,
]);
export type UserMessageSender = z.infer<typeof userMessageSenderSchema>;
export type AssistantMessageSender = z.infer<typeof agentSenderSchema>;

/**
 * `chat.subscribe@1.4` - Wire-freeze copy of {@link agentSenderSchema} WITHOUT `inReplyTo`, bound to the released `chat.subscribe@1.0-1.3` serverFrames (via the frozen chat-tree variants below) so a peer that negotiated.
 * Extend the live `agentSenderSchema` and freeze here explicitly.
 */
export const agentSenderSchemaPreInReplyTo = z.object({
  type: z.literal("agent"),
  // Pre-Reasonix pin: this copy is bound only to released `1.0-1.3`, so it
  // carries the enum freeze as well as the `inReplyTo` freeze.
  harnessId: guiHarnessIdSchemaPreReasonix,
  agentId: z.string(),
  displayName: z.string().nullable(),
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

export const userMessageSenderSchemaPreInReplyTo = z.discriminatedUnion(
  "type",
  [userSenderSchema, agentSenderSchemaPreInReplyTo],
);

/**
 * `chat.subscribe@1.4` - Wire-freeze copy of the LIVE {@link agentSenderSchema} (it keeps `inReplyTo`) with `harnessId` pinned to the pre-Reasonix enum.
 */
export const agentSenderSchemaPreReasonix = z.object({
  type: z.literal("agent"),
  harnessId: guiHarnessIdSchemaPreReasonix,
  agentId: z.string(),
  displayName: z.string().nullable(),
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
  inReplyTo: z.string().nullable().default(null),
});

export const userMessageSenderSchemaPreReasonix = z.discriminatedUnion("type", [
  userSenderSchema,
  agentSenderSchemaPreReasonix,
]);

export const activeSessionChainSchema = z.object({
  harnessId: guiHarnessIdSchema,
  sessionId: z.string(),
  // Historical workspace state for resume/fork decisions. Runtime turns must
  // use a fresh ProviderWorkspace derived from the current visible binding.
  sessionWorkspaceSnapshot: sessionWorkspaceSnapshotSchema,
  // The live session's fake-context seed (see the anchor-field comment below).
  // Written on session created/resumed from the turn's routing value, so it never waits on the later user-message anchor event - closing the crash window where a fresh seeded session has a chain but no anchor yet.
  coveredUntilMessageId: z.string().nullable().default(null),
  // Which profile (subscription) owns the live session this chain resumes.
  // A resume is only authorized when this matches the chat's current settings; a profile switch (like a harness switch) must fall through to fresh session routing instead of silently continuing on the new profile's env.
  profileId: z.string().nullable().default(null),
});
export type ActiveChain = z.infer<typeof activeSessionChainSchema>;

/**
 * Wire-freeze copy of {@link activeSessionChainSchema} with `harnessId` pinned to the pre-Reasonix enum, bound to the frozen chat records for released `chat.subscribe@1.0-1.5`.
 */
export const activeSessionChainSchemaPreReasonix = z.object({
  harnessId: guiHarnessIdSchemaPreReasonix,
  sessionId: z.string(),
  sessionWorkspaceSnapshot: sessionWorkspaceSnapshotSchema,
  coveredUntilMessageId: z.string().nullable().default(null),
  profileId: z.string().nullable().default(null),
});

// `coveredUntilMessageId` (on every anchor below) records the last chat message covered by the fake-context seed file written when this session's lineage root was seeded; the file's content is a pure function of the.
// Profile snapshot recorded when this session was minted: which logged-in profile (subscription) owned it, captured at write time so history renders correctly even after a profile is later renamed or removed (tombstoned).
const profileSnapshotFields = {
  profileId: z.string().nullable().default(null),
  labelSnapshot: z.string().nullable().default(null),
  accountUuid: z.string().nullable().default(null),
  accentColor: z.string().nullable().default(null),
} as const;

export const claudeChatSessionAnchorSchema = z.object({
  harnessId: z.literal("claude"),
  hostId: z.string(),
  sessionId: z.string(),
  sessionWorkspaceSnapshot: sessionWorkspaceSnapshotSchema,
  claudeMessageUuid: z.string(),
  // Last transcript row uuid of this message's turn slice, recorded live from the stream (monotone last-write-wins) rather than re-derived later from the transcript.
  // `claudeMessageUuid` marks where the turn STARTS; this marks where it ENDS, which is what a rewind fork must slice at.
  turnTailUuid: z.string().nullable().default(null),
  createdAt: z.number(),
  coveredUntilMessageId: z.string().nullable().default(null),
  ...profileSnapshotFields,
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
  ...profileSnapshotFields,
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
  ...profileSnapshotFields,
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
  ...profileSnapshotFields,
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
  ...profileSnapshotFields,
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
  ...profileSnapshotFields,
});
export type OpenRouterChatSessionAnchor = z.infer<
  typeof openRouterChatSessionAnchorSchema
>;

export const grokChatSessionAnchorSchema = z.object({
  harnessId: z.literal("grok"),
  hostId: z.string(),
  sessionId: z.string(),
  sessionWorkspaceSnapshot: sessionWorkspaceSnapshotSchema,
  createdAt: z.number(),
  coveredUntilMessageId: z.string().nullable().default(null),
  ...profileSnapshotFields,
});
export type GrokChatSessionAnchor = z.infer<typeof grokChatSessionAnchorSchema>;

export const qwenChatSessionAnchorSchema = z.object({
  harnessId: z.literal("qwen"),
  hostId: z.string(),
  sessionId: z.string(),
  sessionWorkspaceSnapshot: sessionWorkspaceSnapshotSchema,
  createdAt: z.number(),
  coveredUntilMessageId: z.string().nullable().default(null),
  ...profileSnapshotFields,
});
export type QwenChatSessionAnchor = z.infer<typeof qwenChatSessionAnchorSchema>;
// Kiro (ACP) resumes at session granularity only - `session/load` reloads the
// whole ACP session, with no per-message truncation/fork point.
export const kiroChatSessionAnchorSchema = z.object({
  harnessId: z.literal("kiro"),
  hostId: z.string(),
  sessionId: z.string(),
  sessionWorkspaceSnapshot: sessionWorkspaceSnapshotSchema,
  createdAt: z.number(),
  coveredUntilMessageId: z.string().nullable().default(null),
  ...profileSnapshotFields,
});
export type KiroChatSessionAnchor = z.infer<typeof kiroChatSessionAnchorSchema>;

export const droidChatSessionAnchorSchema = z.object({
  harnessId: z.literal("droid"),
  hostId: z.string(),
  sessionId: z.string(),
  sessionWorkspaceSnapshot: sessionWorkspaceSnapshotSchema,
  createdAt: z.number(),
  coveredUntilMessageId: z.string().nullable().default(null),
  ...profileSnapshotFields,
});
export type DroidChatSessionAnchor = z.infer<
  typeof droidChatSessionAnchorSchema
>;

export const kimiChatSessionAnchorSchema = z.object({
  harnessId: z.literal("kimi"),
  hostId: z.string(),
  sessionId: z.string(),
  sessionWorkspaceSnapshot: sessionWorkspaceSnapshotSchema,
  createdAt: z.number(),
  coveredUntilMessageId: z.string().nullable().default(null),
  ...profileSnapshotFields,
});
export type KimiChatSessionAnchor = z.infer<typeof kimiChatSessionAnchorSchema>;

// Copilot (ACP) resumes at session granularity only - `session/load` reloads the whole ACP session, with no per-message truncation/fork point.
export const copilotChatSessionAnchorSchema = z.object({
  harnessId: z.literal("copilot"),
  hostId: z.string(),
  sessionId: z.string(),
  sessionWorkspaceSnapshot: sessionWorkspaceSnapshotSchema,
  createdAt: z.number(),
  coveredUntilMessageId: z.string().nullable().default(null),
  ...profileSnapshotFields,
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
  ...profileSnapshotFields,
});
export type KilocodeChatSessionAnchor = z.infer<
  typeof kilocodeChatSessionAnchorSchema
>;

// Amp resumes at thread granularity only - `execute`'s `options.continue` reloads the whole Amp thread, with no per-message truncation/fork point.
export const ampChatSessionAnchorSchema = z.object({
  harnessId: z.literal("amp"),
  hostId: z.string(),
  sessionId: z.string(),
  sessionWorkspaceSnapshot: sessionWorkspaceSnapshotSchema,
  createdAt: z.number(),
  coveredUntilMessageId: z.string().nullable().default(null),
  ...profileSnapshotFields,
});
export type AmpChatSessionAnchor = z.infer<typeof ampChatSessionAnchorSchema>;

export const devinChatSessionAnchorSchema = z.object({
  harnessId: z.literal("devin"),
  hostId: z.string(),
  sessionId: z.string(),
  sessionWorkspaceSnapshot: sessionWorkspaceSnapshotSchema,
  createdAt: z.number(),
  coveredUntilMessageId: z.string().nullable().default(null),
  ...profileSnapshotFields,
});
export type DevinChatSessionAnchor = z.infer<
  typeof devinChatSessionAnchorSchema
>;

// Pi resumes at session granularity only - no per-message truncation/fork point - so the anchor carries just the session id.
export const piChatSessionAnchorSchema = z.object({
  harnessId: z.literal("pi"),
  hostId: z.string(),
  sessionId: z.string(),
  sessionWorkspaceSnapshot: sessionWorkspaceSnapshotSchema,
  createdAt: z.number(),
  coveredUntilMessageId: z.string().nullable().default(null),
  ...profileSnapshotFields,
});
export type PiChatSessionAnchor = z.infer<typeof piChatSessionAnchorSchema>;

export const hermesChatSessionAnchorSchema = z.object({
  harnessId: z.literal("hermes"),
  hostId: z.string(),
  sessionId: z.string(),
  sessionWorkspaceSnapshot: sessionWorkspaceSnapshotSchema,
  createdAt: z.number(),
  coveredUntilMessageId: z.string().nullable().default(null),
  ...profileSnapshotFields,
});
export type HermesChatSessionAnchor = z.infer<
  typeof hermesChatSessionAnchorSchema
>;

export const ompChatSessionAnchorSchema = z.object({
  harnessId: z.literal("omp"),
  hostId: z.string(),
  sessionId: z.string(),
  sessionWorkspaceSnapshot: sessionWorkspaceSnapshotSchema,
  createdAt: z.number(),
  coveredUntilMessageId: z.string().nullable().default(null),
  ...profileSnapshotFields,
});
export type OmpChatSessionAnchor = z.infer<typeof ompChatSessionAnchorSchema>;

export const huggingFaceChatSessionAnchorSchema = z.object({
  harnessId: z.literal("huggingface"),
  hostId: z.string(),
  sessionId: z.string(),
  sessionWorkspaceSnapshot: sessionWorkspaceSnapshotSchema,
  opencodeUserMessageId: z.string(),
  createdAt: z.number(),
  coveredUntilMessageId: z.string().nullable().default(null),
  ...profileSnapshotFields,
});
export type HuggingFaceChatSessionAnchor = z.infer<
  typeof huggingFaceChatSessionAnchorSchema
>;

export const reasonixChatSessionAnchorSchema = z.object({
  harnessId: z.literal("reasonix"),
  hostId: z.string(),
  sessionId: z.string(),
  sessionWorkspaceSnapshot: sessionWorkspaceSnapshotSchema,
  createdAt: z.number(),
  coveredUntilMessageId: z.string().nullable().default(null),
  ...profileSnapshotFields,
});
export type ReasonixChatSessionAnchor = z.infer<
  typeof reasonixChatSessionAnchorSchema
>;

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
  devinChatSessionAnchorSchema,
  piChatSessionAnchorSchema,
  hermesChatSessionAnchorSchema,
  ompChatSessionAnchorSchema,
  huggingFaceChatSessionAnchorSchema,
  reasonixChatSessionAnchorSchema,
]);
export type ChatSessionAnchor = z.infer<typeof chatSessionAnchorSchema>;

// Wire-freeze copy of the LIVE anchor union minus the Reasonix variant, bound to every released line (`chat.subscribe@1.0-1.6`).
// It keeps every live anchor field (including the Claude `turnTailUuid` - the released baseline proves all of those minors shipped it) and drops only the discriminant a released client cannot decode.
export const chatSessionAnchorSchemaPreReasonix = z.discriminatedUnion(
  "harnessId",
  [
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
    devinChatSessionAnchorSchema,
    piChatSessionAnchorSchema,
    hermesChatSessionAnchorSchema,
    ompChatSessionAnchorSchema,
    huggingFaceChatSessionAnchorSchema,
  ],
);
