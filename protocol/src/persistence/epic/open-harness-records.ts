/**
 * The epic's chat records with every HEARD-FROM harness id reopened to a plain
 * string: a row's agent sender, a steer block's sender, an event's actor, a
 * provider notice's harness, a plan block's harness and source harness.
 *
 * Two readers need these shapes, and neither wrote the record. A
 * `chat.subscribe@1.22` client decodes rows the host streams to it
 * (`host/agent/gui/open-harness-wire.ts` builds that line's frames from these),
 * and the transcript reader library under `persistence/chat-transcript/` folds
 * rows for the host and for that client alike. A reader that predates a harness
 * still has to fold, measure and render a row that merely names it, so the
 * readers are typed against these; the writer, which is the host, keeps the
 * closed `messageSchema` / `chatEventSchema` because a value it stores must be
 * one it knows. Every closed record is assignable to its open twin, so a reader
 * typed here accepts both.
 *
 * What stays CLOSED here, on purpose: the leaves a client would have to DRIVE
 * (the chat's run settings, its session chain, held wake chains) and a user
 * row's `sessionAnchor`, which is a discriminated union with a per-harness
 * resume payload and so has no string to decode an unknown arm into. See
 * `open-harness-wire.ts` for the full heard / drive table.
 *
 * Copies are DERIVED from the live schema (`.extend`, or a spread of `.shape`
 * with the check re-applied where a refinement makes `.extend` refuse), never
 * hand-copied field for field: one leaf widens and every other field keeps
 * flowing from the live schema at its live type. `persistence/chat-sync/
 * open-harness.ts` is the same idea for the cloud record and reuses this
 * `openHarnessIdSchema`; its leaf table is wider (it reopens the run settings
 * and the notice kind too) because its reader never drives the chat.
 */
import { chatEventSchema } from "@traycer/protocol/persistence/epic/chat-events";
import { chatSchema } from "@traycer/protocol/persistence/epic/chat";
import {
  approvalBlockSchema,
  artifactOperationBlockSchema,
  autonomousResumeBlockSchema,
  commandBlockSchema,
  compactionBlockSchema,
  errorBlockSchema,
  fileChangeBlockSchema,
  interviewBlockSchema,
  planBlockSchema,
  planSourceSchema,
  providerNoticeMetadataSchema,
  reasoningBlockSchema,
  steerBlockSchema,
  subAgentBlockSchema,
  textBlockSchema,
  todoBlockSchema,
  toolCallBlockSchema,
} from "@traycer/protocol/persistence/epic/content-blocks";
import {
  assistantMessageSchema,
  userMessageSchema,
} from "@traycer/protocol/persistence/epic/messages";
import {
  agentSenderSchema,
  userSenderSchema,
} from "@traycer/protocol/persistence/epic/senders";
import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * A harness id as a reader takes it: any non-empty string. The closed enum is
 * the writer's; a reader renders an id it does not recognise as a generic
 * agent rather than failing the record.
 */
export const openHarnessIdSchema = lazySchema(() => z.string().min(1));

// ---- Senders ----------------------------------------------------------- //

export const openAgentSenderSchema = lazySchema(() =>
  agentSenderSchema.extend({
    harnessId: openHarnessIdSchema,
  }),
);
export type OpenAgentSender = z.infer<typeof openAgentSenderSchema>;

export const openUserMessageSenderSchema = lazySchema(() =>
  z.discriminatedUnion("type", [userSenderSchema, openAgentSenderSchema]),
);
export type OpenUserMessageSender = z.infer<typeof openUserMessageSenderSchema>;

// ---- Content blocks ---------------------------------------------------- //

// A spread of the live shape, not `.extend()`: the base carries a refinement
// (`noticeKind` must match `metadata.type`), which Zod's derivation helpers
// refuse to widen through. Only `harnessId` is reopened; `noticeKind` stays
// the closed enum the GUI's notice renderers were written against.
export const openProviderNoticeMetadataSchema = lazySchema(() =>
  z
    .object({
      ...providerNoticeMetadataSchema.shape,
      harnessId: openHarnessIdSchema,
    })
    .superRefine((notice, ctx) => {
      if (
        notice.metadata !== null &&
        notice.noticeKind !== notice.metadata.type
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "noticeKind must match metadata.type",
          path: ["metadata", "type"],
        });
      }
    }),
);
export type OpenProviderNoticeMetadata = z.infer<
  typeof openProviderNoticeMetadataSchema
>;

export const openTextBlockSchema = lazySchema(() =>
  textBlockSchema.extend({
    providerNotice: openProviderNoticeMetadataSchema.nullable().default(null),
  }),
);
export type OpenTextBlock = z.infer<typeof openTextBlockSchema>;

export const openPlanSourceSchema = lazySchema(() =>
  planSourceSchema.extend({
    harnessId: openHarnessIdSchema,
  }),
);
export type OpenPlanSource = z.infer<typeof openPlanSourceSchema>;

export const openPlanBlockSchema = lazySchema(() =>
  planBlockSchema.extend({
    harnessId: openHarnessIdSchema,
    source: openPlanSourceSchema,
  }),
);
export type OpenPlanBlock = z.infer<typeof openPlanBlockSchema>;

export const openSteerBlockSchema = lazySchema(() =>
  steerBlockSchema.extend({
    sender: openUserMessageSenderSchema.nullable().default(null),
  }),
);
export type OpenSteerBlock = z.infer<typeof openSteerBlockSchema>;

/**
 * The content-block union with its three harness-bearing members reopened.
 * Every other member is the live schema; a NEW member has to be added here,
 * which `open-harness-wire.test.ts` enforces by comparing member sets.
 */
export const openContentBlockSchema = lazySchema(() =>
  z.discriminatedUnion("type", [
    openTextBlockSchema,
    reasoningBlockSchema,
    toolCallBlockSchema,
    fileChangeBlockSchema,
    commandBlockSchema,
    subAgentBlockSchema,
    approvalBlockSchema,
    todoBlockSchema,
    openPlanBlockSchema,
    errorBlockSchema,
    compactionBlockSchema,
    autonomousResumeBlockSchema,
    openSteerBlockSchema,
    interviewBlockSchema,
    artifactOperationBlockSchema,
  ]),
);
export type OpenContentBlock = z.infer<typeof openContentBlockSchema>;

// ---- Messages, events, the chat --------------------------------------- //

// A spread of the live shape with the `sender.type === message.kind` check
// re-applied, for the reason the notice gives. `sessionAnchor` is KEPT, closed:
// see the module note.
export const openUserMessageSchema = lazySchema(() =>
  z
    .object({
      ...userMessageSchema.shape,
      sender: openUserMessageSenderSchema,
    })
    .superRefine((message, ctx) => {
      if (message.sender.type === message.message.kind) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["message", "kind"],
        message: "User message sender.type must match message.kind.",
      });
    }),
);
export type OpenUserMessage = z.infer<typeof openUserMessageSchema>;

export const openAssistantMessageSchema = lazySchema(() =>
  assistantMessageSchema.extend({
    sender: openAgentSenderSchema,
    blocks: z.array(openContentBlockSchema),
  }),
);
export type OpenAssistantMessage = z.infer<typeof openAssistantMessageSchema>;

export const openMessageSchema = lazySchema(() =>
  z.discriminatedUnion("role", [
    openUserMessageSchema,
    openAssistantMessageSchema,
  ]),
);
export type OpenMessage = z.infer<typeof openMessageSchema>;

export const openChatEventSchema = lazySchema(() =>
  chatEventSchema.extend({
    actor: openUserMessageSenderSchema.nullable(),
  }),
);
export type OpenChatEvent = z.infer<typeof openChatEventSchema>;

/**
 * The whole chat record as a reader holds it: open rows and events, with the
 * head (`settings`, `activeSessionChain`, the held wake chains) still closed,
 * because a reader that also drives the chat seeds its pickers from the head.
 */
export const openChatSchema = lazySchema(() =>
  chatSchema.extend({
    messages: z.array(openMessageSchema),
    events: z.array(openChatEventSchema),
  }),
);
export type OpenChat = z.infer<typeof openChatSchema>;
