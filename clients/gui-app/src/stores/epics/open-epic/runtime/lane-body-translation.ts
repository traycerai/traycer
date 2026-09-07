/** `artifact.subscribe@1.0`'s body events in the rooms replica's vocabulary. */
import type {
  DocReplicaEvent,
  DocUnavailableEvent,
} from "@traycer-clients/shared/replica-runtime";
import type { EpicRoomEvent } from "./epic-runtime-events";
import type { EpicArtifactRoomAvailability } from "../types";

/** What one body-lane event means to the rooms plane. */
export type LaneBodyTranslation =
  /** Apply this to the rooms replica. */
  | { readonly kind: "room-event"; readonly event: EpicRoomEvent }
  /**
   * The authority is not serving the epoch this body attached under. The epic
   * replica must be REPLACED; this is not a per-body availability state.
   */
  | { readonly kind: "replace-replica" };

/** How a body's unavailability reads as a room-level availability value. */
function availabilityOfUnavailable(
  event: DocUnavailableEvent,
): EpicArtifactRoomAvailability {
  return event.terminal ? "unavailable" : "retrying";
}

/**
 * One body-lane event, translated. Total over the union: a member added by a later minor is a
 * compile error here rather than a body that silently stops updating.
 */
export function laneBodyTranslationOf(
  event: DocReplicaEvent,
): LaneBodyTranslation {
  switch (event.kind) {
    case "doc-snapshot":
      return {
        kind: "room-event",
        event: {
          kind: "room-snapshot",
          artifactRoomId: event.docId,
          update: event.update,
          hostStateVectorBase64: event.hostStateVectorBase64,
          // Both stated by the authority, and both forwarded rather than decided here.
          seed: event.seed,
          docGuid: event.docGuid,
        },
      };
    case "doc-update":
      return {
        kind: "room-event",
        event: {
          kind: "room-update",
          artifactRoomId: event.docId,
          update: event.update,
          // Genuinely absent on this wire. See the field's doc: a `""` here would read as "the host holds
          // nothing" and silently un-retire the body's dirty mark.
          hostStateVectorBase64: null,
          // FORWARDED, not decided here - the same rule `doc-snapshot`'s guid follows one case up.
          docGuid: event.docGuid,
        },
      };
    case "doc-coverage-ack":
      return {
        kind: "room-event",
        event: {
          kind: "room-coverage",
          artifactRoomId: event.docId,
          coverageStateVectorBase64: event.coverageStateVectorBase64,
          // Same forward, same reason.
          docGuid: event.docGuid,
        },
      };
    case "doc-awareness":
      return {
        kind: "room-event",
        event: {
          kind: "room-awareness",
          artifactRoomId: event.docId,
          frame: event.frame,
        },
      };
    case "doc-ready":
      // Independent of whether any bytes have arrived - "ready with no snapshot" is a real state on this
      // lane, and the `@1` arm reports its rooms the same way.
      return {
        kind: "room-event",
        event: {
          kind: "room-availability",
          artifactRoomId: event.docId,
          availability: "ready",
        },
      };
    case "doc-unavailable":
      if (event.code === "stale-authority-epoch") {
        return { kind: "replace-replica" };
      }
      return {
        kind: "room-event",
        event: {
          kind: "room-availability",
          artifactRoomId: event.docId,
          availability: availabilityOfUnavailable(event),
        },
      };
  }
}
