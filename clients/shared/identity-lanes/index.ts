// The lane adapters for the `agentIdentity.*` streams — one per data CLASS.
//
// `agentIdentity.state.subscribe` (the identity's index: settings, documents,
// blobs, shard availability) and `agentIdentity.file.subscribe` (co-edited
// bodies, one per open file), each decoding its own wire contract into the
// shared replica-runtime seam's envelopes. They implement the same `LaneAdapter`
// interface the epic lanes do, which is what lets one runtime hold an epic and
// an identity at once without either knowing about the other.
//
// Nothing here projects, stores, or renders. An adapter decodes and emits; the
// replicas decide what may be applied and the runtime sequences them across
// planes.
//
// The whole family is an OPTIONAL capability on the wire — every method is
// registered `degrade: { kind: "unsupported" }` and is absent from the released
// floor — so a composition that builds these adapters must first establish that
// the host serves them. Against a host that does not, the Identities surface is
// hidden rather than degraded.

export type {
  IdentityStateLaneAdapter,
  IdentityStateLaneAdapterSources,
  IdentityStateLaneStreamClient,
  IdentityStateStreamClientFactory,
} from "./identity-state-lane-adapter";
export { createIdentityStateLaneAdapter } from "./identity-state-lane-adapter";

export type {
  IdentityFileLaneAdapter,
  IdentityFileLaneAdapterSources,
  IdentityFileLaneStreamClient,
  IdentityFileStreamClientFactory,
  IdentityFileStreamClientRequest,
} from "./identity-file-lane-adapter";
export { createIdentityFileLaneAdapter } from "./identity-file-lane-adapter";

export type {
  IdentityFileLaneRequest,
  IdentityShardAvailabilityEvent,
  IdentityStateLaneEvent,
} from "./lane-events";
export { identityFileLaneId, identityStateLaneId } from "./lane-events";

export type {
  IdentityRecordFields,
  IdentityRecordPatchFields,
  IdentityStateRow,
} from "./identity-state-rows";
export {
  IDENTITY_RECORD_ROW_ID,
  IDENTITY_ROW_REMOVE_REASON,
  identityDocumentRowId,
  identityFileRowId,
  identityRowIdFor,
} from "./identity-state-rows";
