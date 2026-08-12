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
 *
 * The epic tree spells harness ids as a closed enum (`guiHarnessIdSchema`,
 * and the shared `harness-id` common record). That is right for a record whose
 * reader is the host that wrote it. It is wrong here: this record's readers
 * are shipped cloud renderers and clone targets, the harness roster grows most
 * releases, and a closed enum turns "this chat runs on a harness you have not
 * heard of" into a hard reject of the WHOLE snapshot - the message's `role` is
 * known, so the passthrough carrier hands it to the known schema, which then
 * fails on the enum. Adding a harness would silently make every affected
 * chat unreadable to every shipped reader.
 *
 * So every closed harness-id leaf reachable from the presentation core is
 * reopened to a plain string here. Readers must render an unrecognized id as a
 * generic label rather than assuming a known provider.
 *
 * The leaves, as swept from the record's domain JSON Schema:
 *
 * | Leaf | Reopened via |
 * |---|---|
 * | `core.settings.harnessId` | `snapshotChatRunSettingsSchema` |
 * | `messages[].sender` (user + assistant) | `snapshotAgentSenderSchema` |
 * | `blocks[].text.providerNotice.harnessId` | `snapshotProviderNoticeMetadataSchema` |
 * | `blocks[].plan.harnessId` / `.source.harnessId` | `snapshotPlanBlockSchema` |
 * | `blocks[].steer.sender` | `snapshotSteerBlockSchema` |
 * | `events[].actor` | `snapshotChatEventSchema` |
 *
 * `messages[].sessionAnchor` is not in this table because it is no longer in
 * the presentation core at all. Its harness id is a per-variant discriminator
 * in a nested discriminated union, so reopening it is not even possible
 * without forking every anchor variant - and a non-null anchor from a new
 * harness would have hard-rejected the whole record, since `role: "user"` is
 * known and the passthrough hands the message to the known schema. Session
 * anchors are session-chain state, which the record's partition puts in the
 * opaque `hostPrivate` section; the host keys them there however it likes. An
 * anchor a writer leaves on the message anyway is simply an unmodeled key: it
 * survives in the message's preserved `raw` and never reaches a schema that
 * could reject it. `chat-sync-open-harness.test.ts` sweeps the record
 * surface and fails if ANY closed harness-id leaf appears.
 *
 * Copies here are DERIVED from the base schema's live shape, never hand-copied
 * field-for-field. The hand-copy convention next door exists for wire freezes,
 * where a future field must not leak onto a released line; the opposite is
 * wanted here - one leaf is widened and every other field keeps flowing from
 * the single source of truth in the epic tree, at its live TYPE, not just its
 * live name.
 *
 * Two bases carry `superRefine` checks, which closes Zod's own derivation
 * helpers for a WIDENING replacement: `.extend()` and `.omit()` refuse outright
 * on a refined schema, and `.safeExtend()` only accepts a narrowing
 * replacement - enum-to-string is precisely what it rejects. Those two spread
 * `base.shape` into a fresh `z.object(...)` and re-apply the check, which keeps
 * the derivation while sidestepping the helpers.
 */

/**
 * A harness id as this record carries it: any non-empty string. Renderers
 * treat an id they do not recognize as a generic agent, never as a failure.
 */
export const openHarnessIdSchema = z.string().min(1);

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

// Spread from the base's live shape rather than `.extend()`: Zod refuses
// `.extend()` / `.omit()` on a schema carrying refinements, and
// `.safeExtend()` only accepts a REPLACEMENT that narrows - widening an enum
// to a string is exactly what it rejects. Spreading `.shape` keeps every other
// field bound to the base's live schema (its type, not just its name), so an
// upstream change lands here with no edit; only the check has to be re-applied
// by hand.
export const snapshotProviderNoticeMetadataSchema = z
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

/**
 * The epic content-block union with its three harness-bearing members
 * reopened. Every other member is the live schema, so a change there lands
 * here with no edit; a NEW member has to be added to this list, which
 * `chat-sync-open-harness.test.ts` enforces by comparing member sets.
 */
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

// `sessionAnchor` is dropped from the base shape, not widened: it is
// session-chain state, which belongs in the opaque `hostPrivate` section
// (see the module note above). Keeping it here would have meant a non-null
// anchor from a newly added harness rejecting the whole record.
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
