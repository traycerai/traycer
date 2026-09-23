/**
 * The ROW vocabulary `agentIdentity.state.subscribe@1.0` decodes into, and the
 * row-key encoding that makes three wire populations addressable in one keyed
 * set.
 *
 * The identity counterpart of `epic-lanes/epic-state-rows.ts`, and deliberately
 * its shape: the shared seam's `RecordRow` / `RecordChange` envelopes are
 * generic over the row because the runtime cares about cursoring, revisions,
 * tombstones and trust and never about what a row IS. This module is the
 * identity index lane's instantiation of that generic.
 *
 * ## One keyed set, three populations, disjoint key spaces
 *
 * A record replica holds ONE map from `rowId` to row, so the populations the
 * lane carries are told apart by their keys rather than by which array they
 * arrived in. The two prefixes below are that encoding, and they are enough on
 * their own: a path may contain anything, but `document:` and `file:` are
 * distinct namespaces and `<prefix><path>` is injective WITHIN a namespace, so
 * no pair of distinct (population, path) keys can alias. That is why this file
 * needs none of the JSON encoding `commentThreadRowId` carries - that key is a
 * PAIR of free-form strings joined together, and a join is what aliases.
 *
 * Keys are opaque to the replica and never parsed back apart: a caller that
 * wants a path asks the row, which carries it.
 *
 * ## Why a removal is a removal here, and not a tombstone row
 *
 * The epic records lane models a deleted artifact as a live-row removal PLUS a
 * tombstone row, because a deleted artifact is still rendered. Identity has no
 * such affordance: a deleted document or blob disappears from the index, and the
 * history it leaves behind is served by `agentIdentity.history.list`, a unary,
 * not by this lane. So `removals` maps to one ordinary `RecordChange.remove` per
 * entry - terminal and absorbing - and there is no payload to find a home for.
 *
 * ## The identity record is a row, and it has two shapes
 *
 * The snapshot carries the identity's settings WHOLE and a delta carries only
 * the fields that commit changed - the evolution block and the title move
 * independently, and a whole-object push would force the host to restate
 * settings it did not re-read. Both arrive under one row key at one revision, so
 * the difference has to live in the row's own type: a consumer that installed a
 * patch wholesale would drop the field the patch legitimately omitted.
 *
 * Hence two members, `"identity"` (replace) and `"identity-patch"` (merge),
 * exactly as the epic lane splits `"epic-meta"` from `"epic-meta-patch"`, and
 * for the same reason a nullable field per key would not do: a nullable
 * `description` would make "unchanged" and "cleared" the same wire value, and on
 * this record `null` IS a real value.
 */
import type {
  AgentIdentityDocumentRow,
  AgentIdentityFileRow,
  AgentIdentityRecordPatch,
  AgentIdentityRecordProjection,
} from "@traycer/protocol/host/agent-identity/state-subscribe";

/** The identity's own settings, complete. Replaces whatever is held. */
export type IdentityRecordFields = AgentIdentityRecordProjection["identity"];

/**
 * Only the settings fields one commit changed. MERGE onto what is held -
 * installing this wholesale drops every field the patch omitted, which is the
 * whole reason it is a separate member rather than the same one with missing
 * keys.
 */
export type IdentityRecordPatchFields = AgentIdentityRecordPatch["identity"];

/** One row on the identity index lane, tagged by which population it came from. */
export type IdentityStateRow =
  /** The identity's settings record, complete. */
  | { readonly kind: "identity"; readonly identity: IdentityRecordFields }
  /** Only the fields one commit changed. See the module doc. */
  | {
      readonly kind: "identity-patch";
      readonly identity: IdentityRecordPatchFields;
    }
  /**
   * One markdown file: which shard holds its fragment, and under what name.
   * The body itself rides `agentIdentity.file.subscribe`, per open file.
   */
  | { readonly kind: "document"; readonly row: AgentIdentityDocumentRow }
  /** One blob: the file plane's manifest entry, keyed by its path. */
  | { readonly kind: "file"; readonly row: AgentIdentityFileRow };

const DOCUMENT_ROW_PREFIX = "document:";
const FILE_ROW_PREFIX = "file:";

/**
 * The identity-record row's key. A SINGLETON, and the whole and patch shapes
 * share it: they are two statements about ONE entity at one revision, so
 * splitting them across two keys would let a patch apply while the guard on the
 * whole record was looking somewhere else.
 */
export const IDENTITY_RECORD_ROW_ID = "identity";

/** The index row for the markdown file at `path`. */
export function identityDocumentRowId(path: string): string {
  return `${DOCUMENT_ROW_PREFIX}${path}`;
}

/** The index row for the blob at `path`. */
export function identityFileRowId(path: string): string {
  return `${FILE_ROW_PREFIX}${path}`;
}

/**
 * The key for a removal the lane addressed by `(population, path)`.
 *
 * `population` is read off the wire rather than re-derived from the path, and
 * that is the contract's own instruction: which map a path belongs to is a HOST
 * rule (`identityBodyKindForPath`), and a client re-deriving it would eventually
 * disagree with the host that wrote the row - removing nothing, or removing the
 * wrong half of a path that exists in both senses across a rename.
 */
export function identityRowIdFor(
  population: "document" | "file",
  path: string,
): string {
  return population === "document"
    ? identityDocumentRowId(path)
    : identityFileRowId(path);
}

/**
 * The removal reason stamped on a row the index lane removed.
 *
 * A CLOSED adapter-side constant, and deliberately not a wire field. The
 * `removals` entry carries a population, a path and a revision and nothing else
 * - the host does not record who deleted a file or why - so a `reason` on the
 * wire would be a field with nothing truthful to put in it, and a fabricated one
 * is worse than an honest constant because nothing downstream could tell it from
 * a real answer. Attribution IS available, one unary over: `agentIdentity
 * .history.list` serves the version log with its provenance.
 */
export const IDENTITY_ROW_REMOVE_REASON = "identity-index-removal";
