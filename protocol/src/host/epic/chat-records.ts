import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import { cloudChatVisibilitySchema } from "@traycer/protocol/host/epic/cloud-chat";
import {
  tuiAgentRecordSummarySchema,
  tuiAgentRecordSummaryV12Schema,
} from "@traycer/protocol/host/epic/tui-agent-records";
// The PERSISTED variant, with its `.default(...)` backstops, and not the wire-strict one: this is a read of a record that may have been written before `serviceTier` or `profileId` existed, and the strict schema exists to.
import {
  agentModeSchema,
  chatRunSettingsSchema,
  guiHarnessIdSchema,
  permissionModeSchema,
} from "@traycer/protocol/persistence/epic/foundation";

const textFrameFields = {
  hasBinaryPayload: z.literal(false),
} as const;

/**
 * The epic's chat RECORDS, as its serving host's chat registry holds them.
 * The authorization decision is not made here and never was.
 */
export const listChatRecordsRequestSchema = z.object({
  epicId: z.string().min(1),
});
export type ListChatRecordsRequest = z.infer<
  typeof listChatRecordsRequestSchema
>;

/** Row origin, from the SERVING host's point of view. */
export const chatRecordOriginSchema = z.enum(["own", "foreign"]);
export type ChatRecordOrigin = z.infer<typeof chatRecordOriginSchema>;

/** One chat, as the serving host's registry knows it. */
export const chatRecordSummarySchema = z.object({
  chatId: z.string().min(1),
  /**
   * IDENTITY-BEARING, not informational.
   * Anything that keys, caches, dedupes or unions these rows must key on the owner too - dropping it collapses two different people's chats into one entry, which is a privacy bug wearing a UI costume.
   */
  ownerUserId: z.string().min(1),
  /** The host that MINTED the chat - the registry's `originHostId`. */
  originHostId: z.string().min(1),
  title: z.string(),
  isTitleEditedByUser: z.boolean(),
  parentChatId: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  archived: z.boolean(),
  /**
   * WHEN the chat was archived, or `null`.
   * `null` means one of two different things and cannot distinguish them: an active chat, or a FOREIGN archived chat whose timestamp never crossed the cloud row (which carries only the boolean).
   */
  archivedAt: z.number().int().nonnegative().nullable(),
  /**
   * The registry's run-settings SUMMARY: the harness id, or `null` when the chat has no settings (or was written before the field existed).
   */
  runSettingsSummary: z.string().nullable(),
  /** Per-chat MONOTONIC revision of this row's state. */
  revision: z.number().int().nonnegative(),
  /**
   * Who may read the chat - SERVER-AUTHORITATIVE, replicated in.
   * A row that has not yet been published, or whose host has never heard from the server about it, reads `private` - the closed default, so an unsynced row is never rendered as shared.
   */
  visibility: cloudChatVisibilitySchema,
  /** Whether the serving host owns this row or holds a read-only replica. */
  origin: chatRecordOriginSchema,
});
export type ChatRecordSummary = z.infer<typeof chatRecordSummarySchema>;

export const listChatRecordsResponseSchema = z.object({
  chats: z.array(chatRecordSummarySchema),
});
export type ListChatRecordsResponse = z.infer<
  typeof listChatRecordsResponseSchema
>;

// ─── `epic.listChatRecords@1.1` - the doc-remainder union ──────────────────
// The TUI resolver's own comment names the symptom exactly: they do not error, they are simply absent.

/**
 * The `@1.1` row: the `@1.0` summary plus its ORIGIN PLANE.
 * Serving the union without the marker would fix the disappearance and silently introduce that mis-route - the worse bug of the two, because it fails on WRITE instead of on render.
 */
export const chatRecordSummaryV11Schema = chatRecordSummarySchema.extend({
  docResident: z.boolean(),
});
export type ChatRecordSummaryV11 = z.infer<typeof chatRecordSummaryV11Schema>;

export const listChatRecordsResponseV11Schema = z.object({
  chats: z.array(chatRecordSummaryV11Schema),
});
export type ListChatRecordsResponseV11 = z.infer<
  typeof listChatRecordsResponseV11Schema
>;

/**
 * The `@1.1` request: the `@1.0` request plus the caller's own answer to the only question that decides what this method should serve.
 */
export const listChatRecordsRequestV11Schema =
  listChatRecordsRequestSchema.extend({
    hasDocReplica: z.boolean(),
  });
export type ListChatRecordsRequestV11 = z.infer<
  typeof listChatRecordsRequestV11Schema
>;

/**
 * `epic.getChatRunSettings@1.0` - ONE chat's full run-settings tuple.
 * Registered `degrade: { kind: "unsupported" }` and not on the released floor.
 */
export const getChatRunSettingsRequestSchema = z.object({
  epicId: z.string().min(1),
  chatId: z.string().min(1),
});
export type GetChatRunSettingsRequest = z.infer<
  typeof getChatRunSettingsRequestSchema
>;

export const getChatRunSettingsResponseSchema = z.object({
  settings: chatRunSettingsSchema.nullable(),
});
export type GetChatRunSettingsResponse = z.infer<
  typeof getChatRunSettingsResponseSchema
>;

/**
 * Frozen harness id set for `epic.getChatRunSettings@1.0`, as the v1.2.0 tags (2026-08-24) shipped it.
 * Do NOT add ids here - extend the persisted enum and let the v2.0 line carry them.
 */
export const chatRunSettingsHarnessIdSchemaV10 = guiHarnessIdSchema.extract([
  "claude",
  "codex",
  "opencode",
  "traycer",
  "cursor",
  "grok",
  "qwen",
  "kiro",
  "droid",
  "kimi",
  "copilot",
  "kilocode",
  "openrouter",
  "amp",
  "devin",
  "pi",
  "hermes",
  "omp",
  "huggingface",
]);

/** Frozen `epic.getChatRunSettings@1.0` settings tuple. */
export const chatRunSettingsSchemaV10 = z.object({
  harnessId: chatRunSettingsHarnessIdSchemaV10,
  model: z.string().min(1),
  permissionMode: permissionModeSchema,
  reasoningEffort: z.string().nullable(),
  serviceTier: z.string().nullable().default(null),
  agentMode: agentModeSchema,
  profileId: z.string().nullable().default(null),
});
export type ChatRunSettingsV10 = z.infer<typeof chatRunSettingsSchemaV10>;

export const getChatRunSettingsResponseSchemaV10 = z.object({
  settings: chatRunSettingsSchemaV10.nullable(),
});
export type GetChatRunSettingsResponseV10 = z.infer<
  typeof getChatRunSettingsResponseSchemaV10
>;

/**
 * `host.chatRecords.subscribe@1.0` - the record-change PUSH stream, the freshness half of the read above.
 * Never add this name to the unary released floor (`released-floor.ts`), which is fail-closed on the name set.
 */
export const hostChatRecordsSubscribeOpenRequestSchemaV10 = z.object({});
export type HostChatRecordsSubscribeOpenRequestV10 = z.infer<
  typeof hostChatRecordsSubscribeOpenRequestSchemaV10
>;

/**
 * WHY a row stopped being visible to this viewer.
 * A reason this contract version cannot represent would leave a client unable to render the end state at all, so widening it is a NEW MINOR, never a silent addition.
 */
export const chatRecordRemovalReasonSchema = z.enum(["deleted", "revoked"]);
export type ChatRecordRemovalReason = z.infer<
  typeof chatRecordRemovalReasonSchema
>;

/**
 * `epicId` / `chatId` / `revision` are the ENVELOPE - what the delta addresses and where it sits in that chat's order - and every frame carries the parts it can.
 */
// ─── Frozen `host.chatRecords.subscribe@1.0` server-frame set (as shipped) ──
const hostChatRecordsSubscribeSharedServerFrameSchemasV10 = [
  z.object({
    kind: z.literal("upsert"),
    ...textFrameFields,
    epicId: z.string().min(1),
    chatId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    record: chatRecordSummarySchema,
  }),
  z.object({
    kind: z.literal("remove"),
    ...textFrameFields,
    epicId: z.string().min(1),
    chatId: z.string().min(1),
    reason: chatRecordRemovalReasonSchema,
  }),
  z.object({
    kind: z.literal("pong"),
    ...textFrameFields,
  }),
] as const;

type EnvelopeCheckedFrame =
  | {
      readonly kind: "upsert";
      readonly chatId: string;
      readonly revision: number;
      readonly record: { readonly chatId: string; readonly revision: number };
    }
  | {
      readonly kind: "tuiUpsert";
      readonly tuiAgentId: string;
      readonly revision: number;
      readonly record: {
        readonly tuiAgentId: string;
        readonly revision: number;
      };
    }
  | { readonly kind: "remove" }
  | { readonly kind: "tuiRemove" }
  | { readonly kind: "pong" };

/** The @1.0 envelope invariant, verbatim from the original inline refine. */
function refineChatUpsertEnvelope(
  frame: EnvelopeCheckedFrame,
  ctx: z.RefinementCtx,
): void {
  if (frame.kind !== "upsert") return;
  const upsert = frame;
  if (upsert.chatId !== upsert.record.chatId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["chatId"],
      message:
        "An upsert's envelope must address the row it carries - `chatId` must equal `record.chatId`.",
    });
  }
  if (upsert.revision !== upsert.record.revision) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["revision"],
      message:
        "An upsert's envelope must order by the row it carries - `revision` must equal `record.revision`.",
    });
  }
}

/** The @1.1 addition: the same invariant for the terminal-agent upsert. */
function refineTuiUpsertEnvelope(
  frame: EnvelopeCheckedFrame,
  ctx: z.RefinementCtx,
): void {
  if (frame.kind !== "tuiUpsert") return;
  const upsert = frame;
  if (upsert.tuiAgentId !== upsert.record.tuiAgentId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["tuiAgentId"],
      message:
        "A tuiUpsert's envelope must address the row it carries - `tuiAgentId` must equal `record.tuiAgentId`.",
    });
  }
  if (upsert.revision !== upsert.record.revision) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["revision"],
      message:
        "A tuiUpsert's envelope must order by the row it carries - `revision` must equal `record.revision`.",
    });
  }
}

export const hostChatRecordsSubscribeServerFrameSchemaV10 = z
  .discriminatedUnion(
    "kind",
    hostChatRecordsSubscribeSharedServerFrameSchemasV10,
  )
  .superRefine(refineChatUpsertEnvelope);
export type HostChatRecordsSubscribeServerFrameV10 = z.infer<
  typeof hostChatRecordsSubscribeServerFrameSchemaV10
>;

// ─── `host.chatRecords.subscribe@1.1` - additive: terminal-agent deltas ─────
// Additive minor on the `epic.subscribe@1.1` precedent - a client that negotiated @1.0 never receives the new kinds; the host gates emission on the negotiated version.
export const hostChatRecordsSubscribeServerFrameSchemaV11 = z
  .discriminatedUnion("kind", [
    ...hostChatRecordsSubscribeSharedServerFrameSchemasV10,
    z.object({
      kind: z.literal("tuiUpsert"),
      ...textFrameFields,
      epicId: z.string().min(1),
      tuiAgentId: z.string().min(1),
      revision: z.number().int().nonnegative(),
      record: tuiAgentRecordSummarySchema,
    }),
    z.object({
      kind: z.literal("tuiRemove"),
      ...textFrameFields,
      epicId: z.string().min(1),
      tuiAgentId: z.string().min(1),
      reason: chatRecordRemovalReasonSchema,
    }),
  ])
  .superRefine(refineChatUpsertEnvelope)
  .superRefine(refineTuiUpsertEnvelope);
export type HostChatRecordsSubscribeServerFrameV11 = z.infer<
  typeof hostChatRecordsSubscribeServerFrameSchemaV11
>;

// ─── `host.chatRecords.subscribe@1.2` - cross-host terminal-agent replicas ──
// `@1.1` stays installed and FROZEN, and the gate is the negotiated version as before: a `@1.1` subscriber agreed to a `tuiUpsert` carrying the full registry row, so the host must never hand it a narrow `cloud` arm it.
export const hostChatRecordsSubscribeServerFrameSchemaV12 = z
  .discriminatedUnion("kind", [
    ...hostChatRecordsSubscribeSharedServerFrameSchemasV10,
    z.object({
      kind: z.literal("tuiUpsert"),
      ...textFrameFields,
      epicId: z.string().min(1),
      tuiAgentId: z.string().min(1),
      revision: z.number().int().nonnegative(),
      record: tuiAgentRecordSummaryV12Schema,
    }),
    // Unchanged from `@1.1`, restated rather than shared: the frozen `@1.1` union is declared above this point and must not take a reference to a const introduced below it.
    z.object({
      kind: z.literal("tuiRemove"),
      ...textFrameFields,
      epicId: z.string().min(1),
      tuiAgentId: z.string().min(1),
      reason: chatRecordRemovalReasonSchema,
    }),
  ])
  .superRefine(refineChatUpsertEnvelope)
  .superRefine(refineTuiUpsertEnvelope);
export type HostChatRecordsSubscribeServerFrameV12 = z.infer<
  typeof hostChatRecordsSubscribeServerFrameSchemaV12
>;

export const hostChatRecordsSubscribeClientFrameSchemaV10 =
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("ping"),
      ...textFrameFields,
    }),
  ]);
export type HostChatRecordsSubscribeClientFrameV10 = z.infer<
  typeof hostChatRecordsSubscribeClientFrameSchemaV10
>;

export const hostChatRecordsSubscribeV10 = defineStreamRpcContract({
  method: "host.chatRecords.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: hostChatRecordsSubscribeOpenRequestSchemaV10,
  serverFrameSchema: hostChatRecordsSubscribeServerFrameSchemaV10,
  clientFrameSchema: hostChatRecordsSubscribeClientFrameSchemaV10,
});

export const hostChatRecordsSubscribeV11 = defineStreamRpcContract({
  method: "host.chatRecords.subscribe",
  schemaVersion: { major: 1, minor: 1 } as const,
  openRequestSchema: hostChatRecordsSubscribeOpenRequestSchemaV10,
  serverFrameSchema: hostChatRecordsSubscribeServerFrameSchemaV11,
  clientFrameSchema: hostChatRecordsSubscribeClientFrameSchemaV10,
});

export const hostChatRecordsSubscribeV12 = defineStreamRpcContract({
  method: "host.chatRecords.subscribe",
  schemaVersion: { major: 1, minor: 2 } as const,
  openRequestSchema: hostChatRecordsSubscribeOpenRequestSchemaV10,
  serverFrameSchema: hostChatRecordsSubscribeServerFrameSchemaV12,
  clientFrameSchema: hostChatRecordsSubscribeClientFrameSchemaV10,
});
