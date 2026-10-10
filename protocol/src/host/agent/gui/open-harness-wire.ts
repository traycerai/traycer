/**
 * `chat.subscribe@1.22`, the open-harness-id line: every leaf a client merely
 * HEARS a harness through, reopened to a plain string on the wire.
 *
 * The problem this line answers. A chat records who it heard from: an A2A
 * reply's `sender.harnessId`, the steer block that shows it, an event's
 * `actor`, a provider notice, a plan's source, a session announcement. Through
 * `1.21` each of those is a closed enum, so a client that predates a harness
 * cannot decode a chat that merely exchanged a message with an agent on it,
 * and the host refuses the whole chat rather than send a frame the client
 * would drop (`CHAT_HARNESS_REQUIRES_NEWER_CLIENT`). That refusal was the
 * honest answer while the enum was closed; this line is what makes it
 * unnecessary for the heard-from case. A chat on Claude that received one
 * reply from a Command Code agent opens on a `1.22` peer whatever that peer's
 * enum ends at. Renderers treat an id they do not recognise as a generic
 * agent, never as a failure.
 *
 * What stays CLOSED, on purpose. The leaves a client would have to DRIVE keep
 * the enum: the chat's run settings, its active session chain and held wake
 * chains, the active turn, a queued prompt's settings and the fallback tuples
 * all seed the composer, the pickers and the send path, which cannot act on a
 * harness they cannot name. A row's `sessionAnchor` (on the message and in the
 * row context) stays closed too, for a different reason: it is a discriminated
 * union with a per-harness resume payload, so an unknown arm has no string to
 * decode into. The host withholds an anchor a peer's line cannot decode, as it
 * already does for `1.9`-`1.20`. Those carriers are what the host's floor
 * still refuses or withholds; everything in this module is what it no longer
 * needs to.
 *
 * Copies are DERIVED from the live schema (`.extend`, or a spread of `.shape`
 * with the check re-applied where a refinement makes `.extend` refuse), never
 * hand-copied field for field. The hand-copy convention next door is for
 * FREEZES, where a later field must not leak onto a released line; here the
 * opposite is wanted - one leaf widens and every other field keeps flowing from
 * the live schema at its live type. `persistence/chat-sync/open-harness.ts`
 * does the same for the cloud record and this module reuses its
 * `openHarnessIdSchema`; the two leaf tables differ because this one is the
 * wire's, which keeps the run settings closed and the session anchor present.
 *
 * The leaves, as the `chat.subscribe` server frames carry them:
 *
 * | Leaf | Reopened via |
 * |---|---|
 * | user row `sender`, queued prompt `sender` | `openUserMessageSenderSchema` |
 * | assistant row `sender` | `openAgentSenderSchema` |
 * | `blocks[].text.providerNotice.harnessId` | `openProviderNoticeMetadataSchema` |
 * | `blocks[].plan.harnessId` / `.source.harnessId` | `openPlanBlockSchema` |
 * | `blocks[].steer.sender` | `openSteerBlockSchema` |
 * | `events[].actor` | `openChatEventSchema` |
 * | `blockDelta` `session.created` / `session.resumed` `.session.harnessId` | `openRuntimeEventSchema` |
 * | `blockDelta` `plan.*` `.source.harnessId` | `openRuntimeEventSchema` |
 * | `blockDelta` `provider_notice.upsert` `.harnessId` | `openRuntimeEventSchema` |
 * | `blockDelta` `steer.submitted` `.sender` | `openRuntimeEventSchema` |
 *
 * The queue state, the snapshot's tail, the `range` response and the frames
 * that bind these live in `subscribe.ts`, beside the frame builders.
 * `open-harness-wire.test.ts` sweeps the `1.22` server-frame surface and fails
 * if a closed harness-id leaf remains outside the drive set named above, and
 * compares the member sets of the two unions re-listed here against the live
 * ones, so a member added to either cannot silently drop out of this line.
 */
import {
  approvalRequestedEventSchema,
  approvalResolvedEventSchema,
  artifactOperationEventSchema,
  commandCompletedEventSchema,
  commandStartedEventSchema,
  compactionCompletedEventSchema,
  compactionErroredEventSchema,
  compactionStartedEventSchema,
  errorEventSchema,
  fileChangeCompletedEventSchema,
  fileChangeStartedEventSchema,
  imageResolutionUpdatedEventSchema,
  interviewErroredEventSchema,
  interviewRequestedEventSchema,
  interviewResolvedEventSchema,
  planCompletedEventSchema,
  planDeltaEventSchema,
  planUpdatedEventSchema,
  providerNoticeUpsertEventSchema,
  reasoningCompletedEventSchema,
  reasoningDeltaEventSchema,
  runtimePlanSourceSchema,
  runtimeSessionInfoSchema,
  sessionCreatedEventSchema,
  sessionResumedEventSchema,
  steerSubmittedEventSchema,
  subAgentCompletedEventSchema,
  subAgentProgressEventSchema,
  subAgentStartedEventSchema,
  textCompletedEventSchema,
  textDeltaEventSchema,
  todoUpdatedEventSchema,
  toolCallCompletedEventSchema,
  toolCallCompletedEventSchemaPrePage,
  toolCallErroredEventSchema,
  toolCallProgressEventSchema,
  toolCallStartedEventSchema,
  turnCompletedEventSchema,
  turnInterruptedEventSchema,
  turnStartedEventSchema,
  turnStoppedEventSchema,
  usageUpdatedEventSchema,
  userMessageAnchorResolvedEventSchema,
  userMessageAnchorTailUpdatedEventSchema,
  workflowCompletedEventSchema,
  workflowProgressEventSchema,
  workflowStartedEventSchema,
} from "@traycer/protocol/host/agent/gui/agent-runtime";
import {
  openHarnessIdSchema,
  openUserMessageSenderSchema,
} from "@traycer/protocol/persistence/epic/open-harness-records";
import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

// ---- Records ----------------------------------------------------------- //
//
// The record-level copies (senders, content blocks, messages, events, the chat)
// live in `persistence/epic/open-harness-records.ts`, where the transcript
// reader library can reach them without a persistence module importing from
// the wire layer. Re-exported here so a client reads the whole `1.22` surface
// from one place.
export {
  openAgentSenderSchema,
  openAssistantMessageSchema,
  openChatEventSchema,
  openChatSchema,
  openContentBlockSchema,
  openHarnessIdSchema,
  openMessageSchema,
  openPlanBlockSchema,
  openPlanSourceSchema,
  openProviderNoticeMetadataSchema,
  openSteerBlockSchema,
  openTextBlockSchema,
  openUserMessageSchema,
  openUserMessageSenderSchema,
} from "@traycer/protocol/persistence/epic/open-harness-records";
export type {
  OpenAgentSender,
  OpenAssistantMessage,
  OpenChat,
  OpenChatEvent,
  OpenContentBlock,
  OpenMessage,
  OpenPlanBlock,
  OpenPlanSource,
  OpenProviderNoticeMetadata,
  OpenSteerBlock,
  OpenTextBlock,
  OpenUserMessage,
  OpenUserMessageSender,
} from "@traycer/protocol/persistence/epic/open-harness-records";

// ---- Runtime events (`blockDelta`) ------------------------------------- //

export const openRuntimeSessionInfoSchema = lazySchema(() =>
  runtimeSessionInfoSchema.extend({
    harnessId: openHarnessIdSchema,
  }),
);
export type OpenRuntimeSessionInfo = z.infer<
  typeof openRuntimeSessionInfoSchema
>;

export const openSessionCreatedEventSchema = lazySchema(() =>
  sessionCreatedEventSchema.extend({
    session: openRuntimeSessionInfoSchema,
  }),
);

export const openSessionResumedEventSchema = lazySchema(() =>
  sessionResumedEventSchema.extend({
    session: openRuntimeSessionInfoSchema,
  }),
);

export const openRuntimePlanSourceSchema = lazySchema(() =>
  runtimePlanSourceSchema.extend({
    harnessId: openHarnessIdSchema,
  }),
);

export const openPlanDeltaEventSchema = lazySchema(() =>
  planDeltaEventSchema.extend({
    source: openRuntimePlanSourceSchema,
  }),
);

export const openPlanUpdatedEventSchema = lazySchema(() =>
  planUpdatedEventSchema.extend({
    source: openRuntimePlanSourceSchema,
  }),
);

export const openPlanCompletedEventSchema = lazySchema(() =>
  planCompletedEventSchema.extend({
    source: openRuntimePlanSourceSchema,
  }),
);

export const openProviderNoticeUpsertEventSchema = lazySchema(() =>
  providerNoticeUpsertEventSchema.extend({
    harnessId: openHarnessIdSchema,
  }),
);

export const openSteerSubmittedEventSchema = lazySchema(() =>
  steerSubmittedEventSchema.extend({
    sender: openUserMessageSenderSchema.nullable().default(null),
  }),
);

/**
 * The runtime-event union with its seven harness-bearing members reopened.
 * `user_message.anchor_resolved` is NOT among them: its `anchor` is the same
 * per-harness union a row's `sessionAnchor` is, so it stays closed and the host
 * keeps dropping it for a peer that cannot decode the arm. Listed explicitly
 * rather than mapped over the live union, as every frozen copy is, so a member
 * joins this line by a visible edit; the member-set test says when one is
 * missing.
 */
export const openRuntimeEventSchema = lazySchema(() =>
  z.discriminatedUnion("type", [
    textDeltaEventSchema,
    textCompletedEventSchema,
    reasoningDeltaEventSchema,
    reasoningCompletedEventSchema,
    toolCallStartedEventSchema,
    toolCallCompletedEventSchema,
    toolCallErroredEventSchema,
    toolCallProgressEventSchema,
    approvalRequestedEventSchema,
    approvalResolvedEventSchema,
    todoUpdatedEventSchema,
    openPlanDeltaEventSchema,
    openPlanUpdatedEventSchema,
    openPlanCompletedEventSchema,
    compactionStartedEventSchema,
    compactionCompletedEventSchema,
    compactionErroredEventSchema,
    interviewRequestedEventSchema,
    interviewResolvedEventSchema,
    interviewErroredEventSchema,
    subAgentStartedEventSchema,
    subAgentProgressEventSchema,
    subAgentCompletedEventSchema,
    fileChangeStartedEventSchema,
    fileChangeCompletedEventSchema,
    artifactOperationEventSchema,
    commandStartedEventSchema,
    commandCompletedEventSchema,
    openSessionCreatedEventSchema,
    openSessionResumedEventSchema,
    turnStartedEventSchema,
    userMessageAnchorResolvedEventSchema,
    turnCompletedEventSchema,
    turnStoppedEventSchema,
    turnInterruptedEventSchema,
    openSteerSubmittedEventSchema,
    usageUpdatedEventSchema,
    errorEventSchema,
    workflowStartedEventSchema,
    workflowProgressEventSchema,
    workflowCompletedEventSchema,
    openProviderNoticeUpsertEventSchema,
    imageResolutionUpdatedEventSchema,
    userMessageAnchorTailUpdatedEventSchema,
  ]),
);
export type OpenRuntimeEvent = z.infer<typeof openRuntimeEventSchema>;

/** Frozen 1.22 runtime events, before page/app stamps. */
export const openRuntimeEventSchemaPrePage = lazySchema(() =>
  z.discriminatedUnion("type", [
    textDeltaEventSchema,
    textCompletedEventSchema,
    reasoningDeltaEventSchema,
    reasoningCompletedEventSchema,
    toolCallStartedEventSchema,
    toolCallCompletedEventSchemaPrePage,
    toolCallErroredEventSchema,
    toolCallProgressEventSchema,
    approvalRequestedEventSchema,
    approvalResolvedEventSchema,
    todoUpdatedEventSchema,
    openPlanDeltaEventSchema,
    openPlanUpdatedEventSchema,
    openPlanCompletedEventSchema,
    compactionStartedEventSchema,
    compactionCompletedEventSchema,
    compactionErroredEventSchema,
    interviewRequestedEventSchema,
    interviewResolvedEventSchema,
    interviewErroredEventSchema,
    subAgentStartedEventSchema,
    subAgentProgressEventSchema,
    subAgentCompletedEventSchema,
    fileChangeStartedEventSchema,
    fileChangeCompletedEventSchema,
    artifactOperationEventSchema,
    commandStartedEventSchema,
    commandCompletedEventSchema,
    openSessionCreatedEventSchema,
    openSessionResumedEventSchema,
    turnStartedEventSchema,
    userMessageAnchorResolvedEventSchema,
    turnCompletedEventSchema,
    turnStoppedEventSchema,
    turnInterruptedEventSchema,
    openSteerSubmittedEventSchema,
    usageUpdatedEventSchema,
    errorEventSchema,
    workflowStartedEventSchema,
    workflowProgressEventSchema,
    workflowCompletedEventSchema,
    openProviderNoticeUpsertEventSchema,
    imageResolutionUpdatedEventSchema,
    userMessageAnchorTailUpdatedEventSchema,
  ]),
);

export { openMessageSchemaPrePage } from "@traycer/protocol/host/agent/gui/open-harness-pre-page";
