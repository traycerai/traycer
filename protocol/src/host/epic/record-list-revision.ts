/**
 * Revision primitives shared by the two record LIST reads
 * (`epic.listChatRecords`, `epic.listTuiAgents`) and the record delta stream
 * (`host.chatRecords.subscribe`).
 *
 * They live here rather than beside any one of those methods for the reason
 * `lane-cursor.ts` gives for the lane cursor: three surfaces speak one
 * ordering vocabulary, and three spellings of it would be three places for a
 * consumer to compare numbers that are not comparable.
 *
 * ## What the revision is for
 *
 * Both list reads answer out of the serving host's registry and re-assemble
 * every row on every call. On a large epic that is a multi-MB body every 20s
 * per open tab, almost always identical to the last one. The revision is the
 * cheap question that lets the host answer "nothing you hold has changed"
 * instead: the client sends what it holds, the host compares, and a matching
 * pair costs a few hundred bytes rather than a full snapshot.
 *
 * ## Equality only, and why the epoch is not optional
 *
 * `revision` is a counter the serving host maintains for one (viewer, epic)
 * pair; `epoch` names the INSTANCE of the state that counter belongs to. A host
 * restart, a re-hydrate, a root-document replacement or a rebuilt storage
 * instance all restart the counter, so a bare number can walk BACKWARDS to a
 * value a client already holds - and an equality test would then answer
 * "unchanged" to a client that missed every change in between. The epoch is
 * what makes that unrepresentable: a different epoch is never equal, so the
 * answer is a full snapshot.
 *
 * The only legal comparison is EQUALITY, exactly as on
 * `epicLaneAuthorityEpochSchema` (`lane-cursor.ts`). Two epochs do not order,
 * and two revisions from different epochs do not compare at all.
 *
 * Allowed dependencies: `zod` only.
 */
import { z } from "zod";

/**
 * Opaque identity of the STATE the revision counts changes to, for one viewer
 * and one epic on one serving host.
 *
 * `min(1)` so "no epoch" is unrepresentable - an empty epoch would compare
 * equal to another empty epoch and license exactly the stale `unchanged` this
 * field exists to prevent. A host with nothing to say sends no revision at
 * all (the nullable stamp below), never an empty epoch.
 */
export const recordListEpochSchema = z.string().min(1);
export type RecordListEpoch = z.infer<typeof recordListEpochSchema>;

/**
 * The LIST-level revision: how many times the rows this viewer would be served
 * for this epic have changed, within one epoch.
 *
 * Not a row `revision` (`chatRecordSummarySchema.revision`), and the two must
 * never be compared: a row revision orders one entity's own history, while
 * this orders the LIST. A single list revision covers a change to any row in
 * it, and one row's revision moving does not tell you by how much this one
 * moved.
 *
 * Non-decreasing within an epoch, so a consumer may also treat `held + 1` as
 * "the very next change" - which is what the delta stream's `listRevision`
 * stamp is for. Across epochs it means nothing.
 */
export const recordListRevisionSchema = z.object({
  epoch: recordListEpochSchema,
  revision: z.number().int().nonnegative(),
});
export type RecordListRevision = z.infer<typeof recordListRevisionSchema>;

/**
 * A list revision PLUS the touch revision, i.e. everything a client has to
 * hold to ask the gating question.
 *
 * ## Why `touchRevision` is a second counter and not folded into the first
 *
 * A QUIET write - one that moved only `updatedAt` (and the per-row `revision`
 * that rides with it), which is what a streaming chat does on every token
 * batch - deliberately does NOT bump `revision`. If it did, every poll taken
 * while any chat in the epic is streaming would ship a full snapshot, which is
 * the cost this whole mechanism exists to remove.
 *
 * But the client cannot simply ignore those writes either: the sidebar orders
 * and renders recency from `updatedAt`. So quiet writes get their own
 * monotonic counter, and an `unchanged` answer carries compact per-row
 * recency patches for the rows touched since the client's `touchRevision` -
 * tens of bytes each, a handful of rows, instead of the whole list.
 *
 * The three fields travel as ONE object rather than as sibling keys for the
 * reason `epicLaneCursorSchema` states: a revision without its epoch is
 * a number the host would have to interpret against whatever state it happens
 * to hold now. Nesting makes "all three or none" STRUCTURAL, so there is no
 * cross-field runtime check for a later reader to overlook.
 */
export const recordListStampSchema = recordListRevisionSchema.extend({
  touchRevision: z.number().int().nonnegative(),
});
export type RecordListStamp = z.infer<typeof recordListStampSchema>;

/**
 * What an `unchanged` answer carries for a row a QUIET write touched: the
 * recency facts, and nothing else.
 *
 * `id` is the row's own id - `chatId` on the chat list, `tuiAgentId` on the
 * terminal-agent list - deliberately spelled generically, because the patch
 * shape is identical on both surfaces and two spellings would be two places to
 * keep one rule. `ownerUserId` rides along because the record key is the
 * OWNER-QUALIFIED id (see `chatRecordSummarySchema.ownerUserId`): a patch
 * keyed on the bare id would merge two different people's rows.
 *
 * `revision` is the ROW's revision after the write, so a consumer applies the
 * patch under the same supersedes rule it applies a full row under - strictly
 * greater wins, anything else is dropped - and a replayed or reordered patch
 * is harmless without any merge logic.
 *
 * What it deliberately does NOT carry: anything a quiet write cannot have
 * changed. A patch is not a partial row update; it is the recency pair, and a
 * host that wants to report anything else must ship a snapshot.
 */
export const recordListRecencyPatchSchema = z.object({
  id: z.string().min(1),
  ownerUserId: z.string().min(1),
  updatedAt: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
});
export type RecordListRecencyPatch = z.infer<
  typeof recordListRecencyPatchSchema
>;
