// The lane adapters that replace `epic.subscribe` — one per data CLASS.
//
// `epic.state.subscribe` (server-arbitrated rows), `epic.status.subscribe`
// (session control) and `artifact.subscribe` (co-edited bodies), each decoding
// its own wire contract into the shared replica-runtime seam's envelopes. They
// implement the same `LaneAdapter` interface the `@1` legacy arm does, which is
// what makes the mixed fleet a configuration rather than a fork.
//
// Nothing here projects, stores, or renders. An adapter decodes and emits; the
// replicas decide what may be applied and the runtime sequences them across
// planes.

export type {
  EpicStateLaneAdapter,
  EpicStateLaneAdapterSources,
  EpicStateLaneStreamClient,
  EpicStateStreamClientFactory,
} from "./epic-state-lane-adapter";
export { createEpicStateLaneAdapter } from "./epic-state-lane-adapter";

export type {
  EpicStatusLaneAdapter,
  EpicStatusLaneAdapterSources,
  EpicStatusLaneStreamClient,
  EpicStatusStreamClientFactory,
} from "./epic-status-lane-adapter";
export { createEpicStatusLaneAdapter } from "./epic-status-lane-adapter";

export type {
  ArtifactLaneAdapter,
  ArtifactLaneAdapterSources,
  ArtifactLaneStreamClient,
  ArtifactStreamClientFactory,
} from "./artifact-lane-adapter";
export { createArtifactLaneAdapter } from "./artifact-lane-adapter";

export type { ArtifactLaneRequest, EpicStateLaneEvent } from "./lane-events";
export {
  EPIC_STATE_LANE_ID,
  EPIC_STATUS_LANE_ID,
  artifactLaneId,
} from "./lane-events";

export type { EpicStateRow } from "./epic-state-rows";
export {
  ARTIFACT_TOMBSTONE_REMOVE_REASON,
  COMMENT_THREAD_REMOVE_REASON,
  EPIC_META_ROW_ID,
  ROLE_CLAIMS_ROW_ID,
  artifactRowId,
  artifactTombstoneRowId,
  commentThreadRowId,
} from "./epic-state-rows";

export type {
  WorkspaceContextRefreshCause,
  WorkspaceContextRefreshPolicy,
  WorkspaceContextRefreshSources,
} from "./workspace-context-refresh";
export { createWorkspaceContextRefreshPolicy } from "./workspace-context-refresh";

export { EPIC_LANE_METHODS, hostServesEpicLanes } from "./lane-capability";
