/**
 * The lane ids and the two event arms the shared seam's envelopes could not express, for the three adapters that replace `epic.subscribe`.
 * Both halves live in the state adapter, which is the only lane with a positional cursor at `@1.0`.
 */
import type {
  LaneId,
  RecordReplicaEvent,
} from "@traycer-clients/shared/replica-runtime";
import type { EpicStateRow } from "./epic-state-rows";

export const EPIC_STATE_LANE_ID: LaneId = "epic.state.subscribe@1";

export const EPIC_STATUS_LANE_ID: LaneId = "epic.status.subscribe@1";

export function artifactLaneId(artifactId: string): LaneId {
  return `artifact.subscribe@1:${artifactId}`;
}

export type EpicStateLaneEvent = RecordReplicaEvent<EpicStateRow>;

/**
 * The outbound half of a body lane.
 * The plane knows whether its own unsent bytes must be retained (a body edit) or may be dropped (awareness, which is fire-and-forget and whose loss CRDT convergence absorbs), and it decides before it calls `send`.
 */
export type ArtifactLaneRequest =
  | {
      readonly kind: "apply-update";
      /**
       * The generation guard on the write path.
       * A host that has reseeded this body drops an update naming the old guid rather than merging it, so a stale replica cannot resurrect content the reseed replaced.
       */
      readonly docGuid: string;
      readonly update: Uint8Array;
    }
  | { readonly kind: "awareness"; readonly frame: Uint8Array };
