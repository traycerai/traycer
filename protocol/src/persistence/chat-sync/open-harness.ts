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
import { chatEventSchema } from "@traycer/protocol/persistence/epic/chat-events";
import { chatRunSettingsSchema } from "@traycer/protocol/persistence/epic/foundation";
import { userMessageSchema } from "@traycer/protocol/persistence/epic/messages";
import {
  agentSenderSchema,
  userSenderSchema,
} from "@traycer/protocol/persistence/epic/senders";
import { z } from "zod";

/**
 * Open harness ids for the `chat-head` / `chat-shard` records.
 * Adding a harness would silently make every affected chat unreadable to every shipped reader.
 */

/**
 * A harness id as this record carries it: any non-empty string. Renderers
 * treat an id they do not recognize as a generic agent, never as a failure.
 */
export const openHarnessIdSchema = z.string().min(1);

/**
 * A provider-notice kind as this record carries it: any non-empty string.
 * Renderers already read only `tone` / `title` / `message` / `details`, so an unrecognized kind is not a rendering decision - it is just a label they do not need.
 */
export const openProviderNoticeKindSchema = z.string().min(1);

// ---- Senders ----------------------------------------------------------- //

export const snapshotAgentSenderSchema = agentSenderSchema.extend({
  harnessId: openHarnessIdSchema,
});
export type SnapshotAgentSender = z.infer<typeof snapshotAgentSenderSchema>;

export const snapshotUserMessageSenderSchema = z.discriminatedUnion("type", [
  userSenderSchema,
  snapshotAgentSenderSchema,
]);
export type SnapshotUserMessageSender = z.infer<
  typeof snapshotUserMessageSenderSchema
>;

// ---- Run settings ------------------------------------------------------ //

export const snapshotChatRunSettingsSchema = chatRunSettingsSchema.extend({
  harnessId: openHarnessIdSchema,
});
export type SnapshotChatRunSettings = z.infer<
  typeof snapshotChatRunSettingsSchema
>;

// ---- Content blocks ---------------------------------------------------- //

// Spread from the base's live shape rather than `.extend()`: Zod refuses `.extend()` / `.omit()` on a schema carrying refinements, and `.safeExtend()` only accepts a REPLACEMENT that narrows - widening an enum to a.
// A cloud renderer needs the kind for nothing - it renders `tone` / `title` / `message` / `details` and no shipped consumer switches on it - so the enum bought type precision the record cannot afford.
export const snapshotProviderNoticeMetadataSchema = z
  .object({
    ...providerNoticeMetadataSchema.shape,
    harnessId: openHarnessIdSchema,
    noticeKind: openProviderNoticeKindSchema,
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
  });

const snapshotTextBlockSchema = textBlockSchema.extend({
  providerNotice: snapshotProviderNoticeMetadataSchema.nullable().default(null),
});

const snapshotPlanSourceSchema = planSourceSchema.extend({
  harnessId: openHarnessIdSchema,
});

const snapshotPlanBlockSchema = planBlockSchema.extend({
  harnessId: openHarnessIdSchema,
  source: snapshotPlanSourceSchema,
});

const snapshotSteerBlockSchema = steerBlockSchema.extend({
  sender: snapshotUserMessageSenderSchema.nullable().default(null),
});

/** The epic content-block union with its three harness-bearing members reopened. */
export const snapshotContentBlockSchema = z.discriminatedUnion("type", [
  snapshotTextBlockSchema,
  reasoningBlockSchema,
  toolCallBlockSchema,
  fileChangeBlockSchema,
  commandBlockSchema,
  subAgentBlockSchema,
  approvalBlockSchema,
  todoBlockSchema,
  snapshotPlanBlockSchema,
  errorBlockSchema,
  compactionBlockSchema,
  autonomousResumeBlockSchema,
  snapshotSteerBlockSchema,
  interviewBlockSchema,
  artifactOperationBlockSchema,
]);
export type SnapshotContentBlock = z.infer<typeof snapshotContentBlockSchema>;

// ---- Messages + events ------------------------------------------------- //

const { sessionAnchor: _sessionAnchor, ...userMessageBaseShape } =
  userMessageSchema.shape;

// Derived from the base's live shape for the same reason as the provider
// notice above; the `sender.type === message.kind` invariant is re-applied.
export const snapshotUserMessageSchema = z
  .object({
    ...userMessageBaseShape,
    sender: snapshotUserMessageSenderSchema,
  })
  .superRefine((message, ctx) => {
    if (message.sender.type === message.message.kind) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["message", "kind"],
      message: "User message sender.type must match message.kind.",
    });
  });

export const snapshotChatEventSchema = chatEventSchema.extend({
  actor: snapshotUserMessageSenderSchema.nullable(),
});
export type SnapshotChatEvent = z.infer<typeof snapshotChatEventSchema>;
