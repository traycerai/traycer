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
  /**
   * The broker thread id this message SETTLED: the message resumes a request
   * the receiving chat itself opened (`expectReply=true` on its own earlier
   * `agent.sendMessage`), either as the counterparty's reply or as the
   * system inactivity notice closing out that thread. `null` for fresh
   * requests, fire-and-forget sends, and rows persisted before this field
   * existed. Distinct from `reply`, which is the NEW expectation this
   * message carries. Consumers use it to tell a thread-resumed turn (it
   * continues the chain that sent the request, keeping that chain's
   * human/agent root) from a fresh agent-initiated request (which roots a
   * new agent-driven chain).
   */
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
 * Wire-freeze copy of {@link agentSenderSchema} WITHOUT `inReplyTo`, bound to
 * the released `chat.subscribe@1.0–1.3` serverFrames (via the frozen chat-tree
 * variants below) so a peer that negotiated an older minor keeps receiving
 * frames a strict decoder accepts — a plain `z.object` silently strips the
 * unmodeled `inReplyTo` key on reparse (the provider-cli-state v2/v3 discipline).
 *
 * Hand-frozen field-for-field, NOT derived via `.omit()`/`.extend()` off the
 * live shape: a future agent-sender field must not silently leak onto the
 * frozen wire. Extend the live `agentSenderSchema` and freeze here explicitly.
 * The live line that carries `inReplyTo` is `chat.subscribe@1.4`.
 */
export const agentSenderSchemaPreInReplyTo = z.object({
  type: z.literal("agent"),
  harnessId: guiHarnessIdSchema,
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
  // Which profile (subscription) owns the live session this chain resumes.
  // `null` means ambient/host login - also the value old chains parse to. A
  // resume is only authorized when this matches the chat's current settings;
  // a profile switch (like a harness switch) must fall through to fresh
  // session routing instead of silently continuing on the new profile's env.
  profileId: z.string().nullable().default(null),
});
export type ActiveChain = z.infer<typeof activeSessionChainSchema>;

// `coveredUntilMessageId` (on every anchor below) records the last chat message
// covered by the fake-context seed file written when this session's lineage root
// was seeded; the file's content is a pure function of the prefix up to and
// including that message. `null` unifies "no seed context ever existed" — a
// session that started the chat (empty prefix, no prelude) and a legacy anchor
// persisted before this field existed. The `.default(null)` lets those old
// anchors parse (matching the legacy-field precedent above).
//
// Profile snapshot recorded when this session was minted: which logged-in
// profile (subscription) owned it, captured at write time so history renders
// correctly even after a profile is later renamed or removed (tombstoned) -
// never re-read live. `profileId: null` means the session ran on the
// ambient/host login, not a Traycer-managed profile - also the value old
// anchors persisted before profiles existed parse to. `accountUuid` is the
// provider's identity id, deliberately NOT email - anchors are Y.Doc
// artifacts that replicate cross-host/cross-collaborator, and email is kept
// host-local (see the multi-profile decision log's PII scope). `accentColor`
// is the profile's accent hex at mint time, so a tombstoned profile's dot
// keeps its color instead of falling back to the id-hash color; `null` for
// anchors minted before this field existed (hash fallback applies) and for
// profiles with no assigned color. Spread into every per-harness variant
// below instead of duplicated per schema.
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
  // Last transcript row uuid of this message's turn slice, recorded live from
  // the stream (monotone last-write-wins) rather than re-derived later from
  // the transcript. `claudeMessageUuid` marks where the turn STARTS; this
  // marks where it ENDS, which is what a rewind fork must slice at. It is a
  // recorded fact where the fallback boundary scan is a best-effort
  // classification of raw rows - the host prefers the FURTHEST endpoint the
  // two can prove, so a tail that went stale (e.g. a crash after later rows
  // were written) extends rather than truncates. The scan itself is
  // compact-proof: it runs over raw transcript rows, which a `/compact`
  // re-root orphans from the parent chain but never removes from the file
  // (only the pre-fix chain-walk view lost them). For a message closed out
  // by a mid-turn steer this is CLEARED, not frozen - steer acceptance is
  // stdin-enqueue, so rows in the enqueue window still belong to the
  // previous message and only the scan (which stops at the steer's
  // queued_command attachment row) knows the true boundary. `null`: cleared
  // by hand-off, anchors persisted before this field existed, or a turn that
  // died before any row streamed - all resolve via the scan alone.
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
  ...profileSnapshotFields,
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
  ...profileSnapshotFields,
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
  ...profileSnapshotFields,
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
  ...profileSnapshotFields,
});
export type AmpChatSessionAnchor = z.infer<typeof ampChatSessionAnchorSchema>;

// Devin (ACP) resumes at session granularity only — `session/load` reloads the
// whole ACP session, with no per-message truncation/fork point — so the anchor
// carries just the ACP session id. `sessionId` is that ACP session id.
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

// Pi resumes at session granularity only — no per-message truncation/fork
// point — so the anchor carries just the session id. `sessionId` is the Pi
// session id.
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

// Hermes (ACP) resumes at session granularity only — `session/load` reloads
// the whole ACP session, with no per-message truncation/fork point — so the
// anchor carries just the ACP session id. `sessionId` is that ACP session id.
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

// omp (Oh My Pi, `omp --mode rpc`) resumes at session granularity only — the
// RPC surface reloads a whole session id with no per-message truncation/fork
// point — so the anchor carries just the session id. `sessionId` is the omp
// RPC session id.
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

// Hugging Face runs on the bundled OpenCode engine (a synthetic
// OpenAI-compatible provider pointed at `router.huggingface.co`), so its anchor
// is opencode-shaped: the OpenCode session id plus the OpenCode user-message id
// that turn started at, which is the truncation/fork point on resume.
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

// Reasonix (`reasonix acp`) resumes at session granularity only — `session/load`
// reloads the whole ACP session and there is no per-message truncation/fork
// point (`session/fork` is genuinely absent: it answers `-32601`) — so the
// anchor carries just the ACP session id. `sessionId` is that ACP session id.
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

// ── Wire-freeze variant (pre-turnTailUuid) ──────────────────────────────────
// Hand-frozen copy of the claude anchor from before `turnTailUuid` existed.
// Bound (via `userMessageSchemaPreTurnTail` -> `messageSchemaPreImage`) to the
// released `chat.subscribe@1.4`/`@1.5` snapshot trees, so those lines can never
// observe the field. It also backed a `1.6` freeze until the release collapsed
// that unreleased minor with `1.7`; `1.6` binds the live schemas now.
// Field-for-field hand copy, NOT `.omit()`, so a future anchor field cannot
// silently leak onto the frozen lines.
export const claudeChatSessionAnchorSchemaPreTurnTail = z.object({
  harnessId: z.literal("claude"),
  hostId: z.string(),
  sessionId: z.string(),
  sessionWorkspaceSnapshot: sessionWorkspaceSnapshotSchema,
  claudeMessageUuid: z.string(),
  createdAt: z.number(),
  coveredUntilMessageId: z.string().nullable().default(null),
  ...profileSnapshotFields,
});

// Non-claude variants reuse their live shapes: the pre-turn-tail freeze point
// only concerns the claude anchor.
export const chatSessionAnchorSchemaPreTurnTail = z.discriminatedUnion(
  "harnessId",
  [
    claudeChatSessionAnchorSchemaPreTurnTail,
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
