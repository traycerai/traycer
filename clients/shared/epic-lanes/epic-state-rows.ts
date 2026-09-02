/**
 * The ROW vocabulary `epic.state.subscribe@1.0` decodes into, and the row-key
 * encoding that makes four wire populations addressable in one keyed set.
 *
 * The shared seam's `RecordRow` / `RecordChange` envelopes are generic over the
 * row on purpose - the runtime cares about cursoring, revisions, tombstones and
 * trust, never about what a row IS. This module is the state lane's
 * instantiation of that generic, and nothing above the adapter needs to know
 * the wire shapes it names.
 *
 * ## One keyed set, several populations, disjoint key spaces
 *
 * A record replica holds ONE map from `rowId` to row, so the four populations
 * the lane carries have to be told apart by their keys rather than by which
 * array they arrived in. The prefixes below are that encoding. They are opaque
 * to the replica and are never parsed back apart by it - a caller that wants an
 * artifact id asks the row, which carries it.
 *
 * ## Why a deleted artifact is a ROW and not merely a removal
 *
 * A tombstoned artifact is still RENDERED: the tree shows deleted-artifact
 * affordances and a link to one must resolve to "deleted" rather than to
 * nothing. So a tombstone is live state with a payload, which a bare
 * `RecordChange.remove` (a row id, a revision and a diagnostic reason) cannot
 * carry.
 *
 * The lane says both things about a tombstone at once, and the adapter emits
 * both, atomically, inside one envelope:
 *
 *  - the LIVE row `artifact:<id>` is REMOVED - terminal and absorbing, so no
 *    later upsert resurrects it on this client;
 *  - the row `artifact-tombstone:<id>` is UPSERTED with the deleted record, so
 *    the deleted-artifact affordance keeps its title and parentage.
 *
 * Two key spaces rather than one row that changes shape, because "removed" has
 * to stay absorbing on the live key while the tombstone payload stays an
 * ordinary revisioned upsert. Collapsing them would force the removal to carry
 * a payload (which the seam's remove arm has nowhere to put) or the tombstone
 * to be an upsert of the live key (which the absorbing rule would then have to
 * make an exception for - and an exception to "removals are terminal" is the
 * bug that resurrects deleted artifacts on flaky links).
 *
 * Both changes carry the SAME revision, which is correct rather than a
 * shortcut: the host mints one revision per artifact ENTITY - live rows and
 * tombstones share `artifactEntityKey(artifactId)` - so the number places the
 * removal in that artifact's history exactly as it places an upsert.
 *
 * ## Epic metadata is a row, and it has two shapes
 *
 * The snapshot carries the epic's metadata WHOLE and a delta carries only the
 * fields that commit changed - `title` and `updatedAt` move independently, and
 * a whole-object push would force the host to restate a title it did not
 * re-read. Both arrive under one row key at one revision, so the difference has
 * to live in the row's own type: a consumer that installed a patch wholesale
 * would drop the field the patch legitimately omitted, which is the same
 * failure `DocSeedMode` exists to prevent one class over.
 *
 * Hence two members, `"epic-meta"` (replace) and `"epic-meta-patch"` (merge),
 * rather than one member with a nullable field per key - a nullable `title`
 * would make "unchanged" and "cleared" the same wire value.
 */
import type {
  EpicArtifactRecord,
  EpicCommentThreadRecord,
  EpicDeletedArtifactRecord,
  EpicMeta,
} from "@traycer/protocol/host/epic/state-subscribe";
import type { RoleClaim } from "@traycer/protocol/persistence/epic/role-claims";

/** One row on the records lane, tagged by which population it came from. */
export type EpicStateRow =
  /** A live artifact in the index. */
  | { readonly kind: "artifact"; readonly record: EpicArtifactRecord }
  /**
   * A deleted artifact, still rendered as a deleted-artifact affordance. Not a
   * removal - see the module doc for why both travel together.
   */
  | {
      readonly kind: "artifact-tombstone";
      readonly record: EpicDeletedArtifactRecord;
    }
  | {
      readonly kind: "comment-thread";
      readonly record: EpicCommentThreadRecord;
    }
  /**
   * The whole visible role-claim SET, revisioned as a set rather than per
   * claim: a claim is created and destroyed but never updated, so a per-claim
   * revision would guard a change that cannot happen. What races is the set,
   * and the set revision is what fences it.
   */
  | { readonly kind: "role-claims"; readonly claims: readonly RoleClaim[] }
  /** The epic's metadata, complete. Replaces whatever is held. */
  | { readonly kind: "epic-meta"; readonly meta: EpicMeta }
  /**
   * Only the metadata fields one commit changed. MERGE onto what is held -
   * installing this wholesale drops every field the patch omitted, which is
   * the whole reason it is a separate member rather than the same one with
   * missing keys.
   */
  | { readonly kind: "epic-meta-patch"; readonly meta: Partial<EpicMeta> };

const ARTIFACT_ROW_PREFIX = "artifact:";
const ARTIFACT_TOMBSTONE_ROW_PREFIX = "artifact-tombstone:";
const COMMENT_THREAD_ROW_PREFIX = "comment-thread:";

/** The live artifact-index row for `artifactId`. */
export function artifactRowId(artifactId: string): string {
  return `${ARTIFACT_ROW_PREFIX}${artifactId}`;
}

/** The deleted-artifact row for `artifactId`, whose live row is removed. */
export function artifactTombstoneRowId(artifactId: string): string {
  return `${ARTIFACT_TOMBSTONE_ROW_PREFIX}${artifactId}`;
}

/**
 * A comment thread's row key.
 *
 * `(artifactId, threadId)` is the row key the contract names, and both parts
 * are needed: thread ids are unique per artifact, not per epic.
 *
 * JSON-encoded rather than `:`-joined. Both ids are `z.string()` on the wire,
 * so a `:` inside either one aliases two distinct pairs onto one row -
 * `("a:b","c")` and `("a","b:c")` - and the consequences are worse than a
 * mixed-up render: a snapshot or upsert overwrites the other thread, and
 * REMOVING either installs an absorbing retraction under the shared key that
 * suppresses the survivor for the rest of the session. Only ever constructed
 * and compared, never parsed, so the encoding is free to change.
 */
export function commentThreadRowId(
  artifactId: string,
  threadId: string,
): string {
  return `${COMMENT_THREAD_ROW_PREFIX}${JSON.stringify([artifactId, threadId])}`;
}

/**
 * The role-claim set's row key. A singleton: the whole set is one row, replaced
 * wholesale and fenced by the set's own revision.
 */
export const ROLE_CLAIMS_ROW_ID = "role-claims";

/**
 * The epic-metadata row's key. Also a singleton, and the whole and patch shapes
 * share it: they are two statements about ONE entity at one revision, so
 * splitting them across two keys would let a patch apply while the guard on the
 * whole record was looking somewhere else.
 */
export const EPIC_META_ROW_ID = "epic-meta";

/**
 * The removal reason stamped on an artifact's live row when the lane
 * tombstones it.
 *
 * A CLOSED adapter-side constant, and deliberately not a wire field. The
 * persisted tombstone carries no attribution - the host does not record who
 * deleted an artifact or why - so a `reason` on the wire would be a field with
 * nothing truthful to put in it, and a fabricated one is worse than an honest
 * constant because nothing downstream could tell it from a real answer. Real
 * deletion attribution is a future host-side feature; until it exists this
 * string says exactly what the client knows, which is that the records lane
 * removed the row.
 */
export const ARTIFACT_TOMBSTONE_REMOVE_REASON = "records-lane-tombstone";

/**
 * The removal reason stamped on a comment thread the lane removed. Same
 * closed-constant rule as {@link ARTIFACT_TOMBSTONE_REMOVE_REASON}: the
 * `commentThreadRemovals` entry carries a row key and a revision and nothing
 * else, and inventing a cause here would put an unfalsifiable claim in front of
 * a user.
 */
export const COMMENT_THREAD_REMOVE_REASON = "records-lane-removal";
