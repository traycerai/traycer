import * as Y from "yjs";

/**
 * Which artifact index a task's root document selects. A task stores its
 * index either in the legacy `artifacts` and `deletedArtifacts` maps under its
 * root map (epoch 0, marked by the absence of an epoch) or in two top-level
 * maps of their own (epoch 1). {@link readArtifactIndexSelection} decides
 * which one, or that neither can be read.
 */

/** The top-level map holding a task's root record, legacy index included. */
export const EPIC_ROOT_MAP_NAME = "epic";
/** The root-map key whose value is the index epoch; absent at epoch 0. */
export const ARTIFACT_INDEX_EPOCH_KEY = "artifactIndexEpoch";
/** The top-level map holding the epoch-1 index rows. */
export const ARTIFACT_INDEX_V1_ROOT = "artifactIndexV1";
/** The top-level map holding the epoch-1 deletion events. */
export const ARTIFACT_DELETIONS_V1_ROOT = "artifactDeletionsV1";

/**
 * `invalid-index`: an epoch was written and removed, an epoch-1 root holds
 * sequence content, or, with no epoch, an epoch-1 root has ever held an item.
 * `unsupported-epoch`: a present epoch other than 1, malformed values
 * included.
 */
export type ArtifactIndexSelection =
  | { readonly state: "ready"; readonly epoch: 0 | 1 }
  | { readonly state: "invalid-index" }
  | { readonly state: "unsupported-epoch" };

const READY_EPOCH_0: ArtifactIndexSelection = Object.freeze({
  state: "ready",
  epoch: 0,
});
const READY_EPOCH_1: ArtifactIndexSelection = Object.freeze({
  state: "ready",
  epoch: 1,
});
const INVALID_INDEX: ArtifactIndexSelection = Object.freeze({
  state: "invalid-index",
});
const UNSUPPORTED_EPOCH: ArtifactIndexSelection = Object.freeze({
  state: "unsupported-epoch",
});

/**
 * Yjs does not encode a top-level type's kind, so a decoded root stays a bare
 * `AbstractType` until something calls `getMap` on it. Its stored items say
 * whether it can be a map: map items live in `_map`, sequence items start at
 * `_start`.
 */
function isMapCompatibleRoot(value: unknown): boolean {
  if (value === undefined) return true;
  if (!(value instanceof Y.AbstractType)) return false;
  if (
    !(value instanceof Y.Map) &&
    !Object.is(value.constructor, Y.AbstractType)
  )
    return false;
  return value._start === null;
}

/** A root that has never held an item, deleted items included. */
function isPristineRoot(value: unknown): boolean {
  if (!isMapCompatibleRoot(value)) return false;
  return (
    value === undefined ||
    (value instanceof Y.AbstractType && value._map.size === 0)
  );
}

/**
 * The selection of the artifact index of `doc`, a task's root document. Reads
 * the raw store only: `getMap` would register a root the document does not
 * hold, or promote a decoded one and walk its history. The cost is constant.
 */
export function readArtifactIndexSelection(doc: Y.Doc): ArtifactIndexSelection {
  const epochItem = doc.share
    .get(EPIC_ROOT_MAP_NAME)
    ?._map.get(ARTIFACT_INDEX_EPOCH_KEY);
  const rows = doc.share.get(ARTIFACT_INDEX_V1_ROOT);
  const deletions = doc.share.get(ARTIFACT_DELETIONS_V1_ROOT);
  if (epochItem === undefined || epochItem.deleted) {
    return epochItem === undefined &&
      isPristineRoot(rows) &&
      isPristineRoot(deletions)
      ? READY_EPOCH_0
      : INVALID_INDEX;
  }
  const values: readonly unknown[] = epochItem.content.getContent();
  if (values[values.length - 1] !== 1) return UNSUPPORTED_EPOCH;
  return isMapCompatibleRoot(rows) && isMapCompatibleRoot(deletions)
    ? READY_EPOCH_1
    : INVALID_INDEX;
}
