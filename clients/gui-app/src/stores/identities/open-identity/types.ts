/**
 * The read model of ONE open identity, as the renderer sees it.
 *
 * The identity counterpart of `open-epic/types.ts`, reduced to what the
 * `agentIdentity.state.subscribe@1.0` index lane carries: the identity's own
 * settings record, its markdown documents, its blob manifest, and which shard
 * rooms the serving host can currently reach. Bodies are not here - a body is
 * a `Y.Doc` held by the body tier per open file, and the store hands out the
 * fragment rather than projecting it.
 *
 * ## Keyed by PATH, never by row id
 *
 * The index lane's row ids are opaque and incarnation-aware: a file deleted and
 * recreated at the same path is a NEW row under a new id, and a rename ships a
 * new row plus the old one's removal. The tree and the body lanes address a
 * file by its path, which is what the user sees and what the body lane's open
 * request names, so every slice here is keyed by `path` and built by scanning
 * the `path` DATA field of the held rows. Nothing parses a row id.
 */
import type {
  AgentIdentityDocumentRow,
  AgentIdentityFileRow,
  AgentIdentityShardAvailability,
} from "@traycer/protocol/host/agent-identity/state-subscribe";
import type { IdentityRecordFields } from "@traycer-clients/shared/identity-lanes";

/** One markdown file the identity holds. `row` is the lane row verbatim. */
export interface IdentityDocumentProjection {
  readonly path: string;
  readonly shardRoomId: string;
  readonly fragmentName: string;
  readonly updatedAt: number;
  readonly provenance: AgentIdentityDocumentRow["provenance"];
}

/** One blob the identity holds. `entry` is the manifest entry verbatim. */
export interface IdentityFileProjection {
  readonly path: string;
  readonly entry: AgentIdentityFileRow["entry"];
}

export interface IdentityDocumentsSlice {
  readonly byPath: Readonly<
    Record<string, IdentityDocumentProjection | undefined>
  >;
  /** Sorted by path, so the tree renders deterministically. */
  readonly allPaths: readonly string[];
}

export interface IdentityFilesSlice {
  readonly byPath: Readonly<Record<string, IdentityFileProjection | undefined>>;
  /** Sorted by path. */
  readonly allPaths: readonly string[];
}

export type IdentityShardState = AgentIdentityShardAvailability["state"];

/**
 * The index lane's populations, as last recomputed.
 *
 * `identity` is `null` before the first snapshot - there is no empty identity
 * to substitute, and a surface that rendered a blank title would be showing
 * something the host never said.
 */
export interface IdentityStateSlices {
  readonly identity: IdentityRecordFields | null;
  readonly documents: IdentityDocumentsSlice;
  readonly files: IdentityFilesSlice;
}

export const EMPTY_ARRAY: readonly string[] = Object.freeze([]);

export const EMPTY_IDENTITY_DOCUMENTS_SLICE: IdentityDocumentsSlice =
  Object.freeze({ byPath: Object.freeze({}), allPaths: EMPTY_ARRAY });

export const EMPTY_IDENTITY_FILES_SLICE: IdentityFilesSlice = Object.freeze({
  byPath: Object.freeze({}),
  allPaths: EMPTY_ARRAY,
});

export const EMPTY_IDENTITY_STATE_SLICES: IdentityStateSlices = Object.freeze({
  identity: null,
  documents: EMPTY_IDENTITY_DOCUMENTS_SLICE,
  files: EMPTY_IDENTITY_FILES_SLICE,
});

/**
 * Whether one file's body can be shown right now.
 *
 * - `awaiting-seed` - a lane is open (or waiting for an epoch) and no `doc`
 *   frame has landed yet. Render a loading state, never an empty editor.
 * - `ready` - a live `Y.Doc` is held and the lane is serving it.
 * - `retrying` - the host said `bodyUnavailable` and kept the subscription;
 *   the last bytes held stay readable, read-only.
 * - `unavailable` - a terminal refusal. `code` says what the surface should do.
 */
export type IdentityFileBodyAvailability =
  | { readonly kind: "awaiting-seed" }
  | { readonly kind: "ready" }
  | { readonly kind: "retrying"; readonly reason: string }
  | {
      readonly kind: "unavailable";
      readonly code:
        | "stale-authority-epoch"
        | "file-not-found"
        | "not-a-fragment"
        | "body-unavailable";
      readonly reason: string;
    };

export const AWAITING_SEED_AVAILABILITY: IdentityFileBodyAvailability =
  Object.freeze({ kind: "awaiting-seed" });

export const READY_AVAILABILITY: IdentityFileBodyAvailability = Object.freeze({
  kind: "ready",
});

/**
 * The transport-level state of the index lane, for the surface's banner.
 *
 * `unsupported` is the one terminal value: the host refused the lane method
 * outright, so the whole family is absent on this connection and no retry will
 * change that. The store never re-dials after it.
 */
export type IdentityConnectionState =
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed"
  | "unsupported";
