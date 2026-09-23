/**
 * Shapes shared by the whole `agentIdentity.*` family.
 *
 * ## Why the namespace is `agentIdentity` and not `identity`
 *
 * `host.identity.get` / `host.identity.set` already exist and mean the HOST's
 * own display name. A second `identity.*` family would put two unrelated
 * subjects one dot apart in the same method table, where the only thing telling
 * them apart is a prefix a reader has to notice.
 *
 * ## Every method here is an OPTIONAL capability
 *
 * Registered `latestMinor: 0` with `degrade: { kind: "unsupported" }`, kept out
 * of `released-floor.ts` and both released-name fixtures. A brand-new method
 * NAME is handshake-fatal on the unary surface, so it rides the optional
 * manifest channel instead; a host that predates this family answers
 * `E_HOST_UNSUPPORTED` and the client hides the Identities section and the
 * composer picker. An `identityId` already persisted on a chat is IGNORED by
 * such a host, which is the failure-mode table's stated behaviour - the chat
 * runs against the stock identity, exactly as it did before identities existed.
 *
 * The two stream methods are ONE capability with the unaries: a client that
 * finds either unsupported must treat the whole family as unsupported rather
 * than rendering a section whose bodies it cannot open.
 */
import { z } from "zod";
import {
  agentIdentityIdSchema,
  guiHarnessIdSchema,
} from "@traycer/protocol/persistence/epic/foundation";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * An identity's id - the id the cloud row is keyed by, and the container id
 * that fills every task-id slot downstream (room derivation, blob key layout,
 * the artifact version log). Every `identityId` in this family's requests,
 * frames and summaries is this schema, so a malformed id is refused at the wire.
 * Defined in the persistence base (see there for the grammar and why it lives
 * there) and re-exported here as the family's own name.
 */
export {
  AGENT_IDENTITY_ID_PATTERN,
  agentIdentityIdSchema,
  type AgentIdentityId,
} from "@traycer/protocol/persistence/epic/foundation";

/**
 * A file's identity-root-relative path, as every method in this family names
 * one.
 *
 * `min(1)` and nothing else HERE, deliberately. The real rule - relative,
 * forward slashes, no `..`, no leading dot segment except the four native skill
 * layouts, and a fixed top-level vocabulary (`SOUL.md`, `memories/`, `skills/`)
 * - is enforced by the HOST at write time and reported through a typed refusal,
 * not by a regex on the wire. Two reasons: the vocabulary grows (the plane's own
 * prefix list is an array precisely so the identity instance can pass
 * `skills/`), and a client that got a regex slightly wrong would be unable to
 * ask a question whose answer is "no, and here is why" - which is strictly worse
 * for the user than a refusal it can render.
 */
export const agentIdentityPathSchema = lazySchema(() => z.string().min(1));

/**
 * The every-N-turns review settings, as the wire carries them.
 *
 * The same four fields the persisted `identity` record holds, restated here
 * rather than imported from `persistence/identity/schemas.ts`. The persisted
 * shape is defaulted throughout, because it is read back out of a Y.Map that a
 * host of any version may have written; a WRITE on this family is a whole-tuple
 * replace, so every field is REQUIRED and a partial object is a validation error
 * instead of a silent null-clobber of settings the caller never looked at. That
 * is the same split `chatRunSettingsStrictSchema` makes against
 * `chatRunSettingsSchema`, and for the same reason.
 *
 * All three selectors are nullable, and `null` means "same as the chat that
 * triggered the pass" rather than an absence.
 */
export const agentIdentityEvolutionSettingsSchema = lazySchema(() =>
  z.object({
    /** `0` disables evolution for this identity. */
    intervalTurns: z.number().int().nonnegative(),
    reviewHarnessId: guiHarnessIdSchema.nullable(),
    reviewModel: z.string().min(1).nullable(),
    reviewReasoningEffort: z.string().nullable(),
  }),
);
export type AgentIdentityEvolutionSettings = z.infer<
  typeof agentIdentityEvolutionSettingsSchema
>;

/**
 * One row of `agentIdentity.list`: the LIGHT fields, and only those.
 *
 * Deliberately not the whole identity. The picker renders a title and the
 * Identities list renders a title plus a description, and everything else an
 * identity holds - its evolution settings, its files, its documents - is served
 * by `agentIdentity.state.subscribe` for the ONE identity a user has opened.
 * Widening this row would make every composer open pay for settings nobody is
 * looking at, which is the same mistake `chatRecordSummarySchema` records for
 * the chat list.
 *
 * There is no tombstone arm, and its absence is the contract: a deleted
 * identity simply does not appear here. A chat whose `identityId` is not in the
 * list is how the composer knows to render "Removed" with a one-click clear,
 * which needs no wire field and cannot go stale against one.
 */
export const agentIdentitySummarySchema = lazySchema(() =>
  z.object({
    identityId: agentIdentityIdSchema,
    title: z.string(),
    description: z.string().nullable(),
    updatedAt: z.number(),
  }),
);
export type AgentIdentitySummary = z.infer<typeof agentIdentitySummarySchema>;

/**
 * WHY a mutation on this family was refused.
 *
 * CLOSED, and closed for the reason `artifactSubscribeUnavailableCodeSchema` is:
 * a client handed only free text would have to STRING-MATCH to decide between
 * "tell the user to pick another name" and "this identity is gone, clear the
 * selection", and those are different products of the same response. A reason
 * this version cannot represent leaves a client unable to explain the refusal at
 * all, so widening is a NEW MINOR, never a silent addition. The human-readable
 * `detail` beside it is for logs, never for branching.
 *
 * - `identityNotFound` - no such identity for this caller, or it is tombstoned.
 * - `invalidPath` - the path is not one the index may key: absolute, escaping,
 *   dot-prefixed outside the native skill layouts, or outside the top-level
 *   vocabulary. See {@link agentIdentityPathSchema} for why the host owns this.
 * - `pathExists` - something already lives there. Renaming ONTO a live path is
 *   refused rather than merged: the index cannot hold two claims about one path,
 *   and silently clobbering is how a skill loses its SKILL.md.
 * - `pathNotFound` - nothing lives there to rename or delete.
 * - `unsupportedBodyKind` - the operation is defined for the other half of the
 *   index. `files.add` mints an empty markdown document, so asking it for a blob
 *   path is a caller bug, not a capacity problem; blobs arrive through
 *   `files.uploadBlob`.
 * - `tooLarge` - over {@link AGENT_IDENTITY_FILE_MAX_BYTES}.
 * - `capExceeded` - the identity is at its file-count or total-byte cap.
 * - `refusedContent` - the plane's ingest refused the bytes themselves:
 *   secret-shaped, a symlink, or a hard link. Distinct from `tooLarge` because
 *   the user's next move is different - remove the file, not shrink it.
 * - `projectionUnavailable` - the host holds no settled projection for this
 *   identity right now. TRANSIENT: the caller retries rather than reporting a
 *   permanent failure.
 */
export const agentIdentityRefusalReasonSchema = lazySchema(() =>
  z.enum([
    "identityNotFound",
    "invalidPath",
    "pathExists",
    "pathNotFound",
    "unsupportedBodyKind",
    "tooLarge",
    "capExceeded",
    "refusedContent",
    "projectionUnavailable",
  ]),
);
export type AgentIdentityRefusalReason = z.infer<
  typeof agentIdentityRefusalReasonSchema
>;

/**
 * The refusal arm every mutation in this family shares.
 *
 * Spread into each response union rather than referenced as a nested object, so
 * `kind` stays the single top-level discriminant a caller switches on.
 */
export const agentIdentityRefusalFields = {
  kind: lazySchema(() => z.literal("refused")),
  reason: agentIdentityRefusalReasonSchema,
  /** Short host-side summary for logs. Never parsed, never rendered as copy. */
  detail: lazySchema(() => z.string()),
} as const;
