/**
 * Four wire populations share one keyed set via opaque prefixes. A tombstone is a live row: remove `artifact:<id>` and upsert `artifact-tombstone:<id>` atomically at the same revision.
 * Epic metadata has replace (`epic-meta`) and merge (`epic-meta-patch`) shapes; a nullable title would make unchanged and cleared the same wire value.
 */
import type {
  EpicArtifactRecord,
  EpicCommentThreadRecord,
  EpicDeletedArtifactRecord,
  EpicMeta,
} from "@traycer/protocol/host/epic/state-subscribe";
import type { RoleClaim } from "@traycer/protocol/persistence/epic/role-claims";

export type EpicStateRow =
  /** A live artifact in the index. */
  | { readonly kind: "artifact"; readonly record: EpicArtifactRecord }
  /** Deleted artifact still rendered as a deleted affordance; not a removal. */
  | {
      readonly kind: "artifact-tombstone";
      readonly record: EpicDeletedArtifactRecord;
    }
  | {
      readonly kind: "comment-thread";
      readonly record: EpicCommentThreadRecord;
    }
  /** Revisioned as a set: a claim is created and destroyed but never updated. */
  | { readonly kind: "role-claims"; readonly claims: readonly RoleClaim[] }
  /** The epic's metadata, complete. Replaces whatever is held. */
  | { readonly kind: "epic-meta"; readonly meta: EpicMeta }
  /** Merge onto what is held; installing wholesale drops every field the patch omitted. */
  | { readonly kind: "epic-meta-patch"; readonly meta: Partial<EpicMeta> };

const ARTIFACT_ROW_PREFIX = "artifact:";
const ARTIFACT_TOMBSTONE_ROW_PREFIX = "artifact-tombstone:";
const COMMENT_THREAD_ROW_PREFIX = "comment-thread:";

export function artifactRowId(artifactId: string): string {
  return `${ARTIFACT_ROW_PREFIX}${artifactId}`;
}

export function artifactTombstoneRowId(artifactId: string): string {
  return `${ARTIFACT_TOMBSTONE_ROW_PREFIX}${artifactId}`;
}

/**
 * `(artifactId, threadId)` JSON-encoded, never `:`-joined: a colon in either id would alias two threads onto one absorbing key.
 * Only constructed and compared, never parsed.
 */
export function commentThreadRowId(
  artifactId: string,
  threadId: string,
): string {
  return `${COMMENT_THREAD_ROW_PREFIX}${JSON.stringify([artifactId, threadId])}`;
}

export const ROLE_CLAIMS_ROW_ID = "role-claims";

/** Whole and patch share this key so a patch cannot apply while the whole-record guard looks elsewhere. */
export const EPIC_META_ROW_ID = "epic-meta";

/** Closed adapter-side constant, not a wire field; the host does not record who deleted an artifact. */
export const ARTIFACT_TOMBSTONE_REMOVE_REASON = "records-lane-tombstone";

/** Closed adapter-side constant; inventing a cause would put an unfalsifiable claim in front of a user. */
export const COMMENT_THREAD_REMOVE_REASON = "records-lane-removal";
