/**
 * `artifact.subscribe@1.0`'s body events in the rooms replica's vocabulary.
 *
 * The twin of `lane-control-translation.ts`, and it exists for the same reason:
 * the rooms replica, the artifact-body tier, the lease policy and the memory
 * accounting are identical on both arms, so translating at this boundary keeps
 * ONE implementation of "what a body is and when it may be applied" rather than
 * one per wire.
 *
 * ## The key changes meaning, and that is the point
 *
 * `EpicRoomEvent.artifactRoomId` is a ROOM id on `@1` and an ARTIFACT id here.
 * That is not a lie being papered over - it is the whole reason
 * `getArtifactRoomId` became `getArtifactBodyDocKey`. The field names the key
 * the body tier holds this document under, and each arm addresses bodies by
 * the id its wire uses: `@1` has rooms that host many bodies, and
 * `artifact.subscribe` has no rooms at all. Nothing downstream of the tier
 * reads it as a room id any more.
 *
 * ## What does NOT translate
 *
 * `stale-authority-epoch` is not an availability state and must never be
 * rendered as one - the client's whole epic view is void, and the answer is to
 * replace the replica, not to grey out one tile. So it is returned as its own
 * outcome for the caller to route into `requestReplacement`, and a translation
 * that folded it into `"unavailable"` would leave the epic silently stale
 * while looking like it had handled the frame.
 */
import type {
  DocReplicaEvent,
  DocUnavailableEvent,
} from "@traycer-clients/shared/replica-runtime";
import type { EpicRoomEvent } from "./epic-runtime-events";
import type { EpicArtifactRoomAvailability } from "../types";

/**
 * What one body-lane event means to the rooms plane.
 *
 * A union rather than `EpicRoomEvent | null`, because the non-room outcome is
 * an INSTRUCTION and a `null` would read as "nothing happened" - which is
 * exactly wrong for a voided epoch, where doing nothing leaves the whole epic
 * silently stale.
 */
export type LaneBodyTranslation =
  /** Apply this to the rooms replica. */
  | { readonly kind: "room-event"; readonly event: EpicRoomEvent }
  /**
   * The authority is not serving the epoch this body attached under. The epic
   * replica must be REPLACED; this is not a per-body availability state.
   */
  | { readonly kind: "replace-replica" };

/**
 * How a body's unavailability reads as a room-level availability value.
 *
 * `terminal` rather than `code` decides, which is the seam's own distinction:
 * `"body-unavailable"` is genuinely both retrying and given-up, and the event
 * carries a separate boolean precisely so neither has to be inferred from the
 * code. A retrying body shows a transient state without tearing the tile down;
 * a terminal one is unavailable until the consumer reattaches.
 */
function availabilityOfUnavailable(
  event: DocUnavailableEvent,
): EpicArtifactRoomAvailability {
  return event.terminal ? "unavailable" : "retrying";
}

/**
 * One body-lane event, translated. Total over the union: a member added by a
 * later minor is a compile error here rather than a body that silently stops
 * updating.
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
          // Both stated by the authority, and both forwarded rather than
          // decided here. This is the pair the tier's merge-vs-seed-vs-replace
          // rule reads, and the reason that rule could move out of the applier
          // at all.
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
          // Genuinely absent on this wire. See the field's doc: a `""` here
          // would read as "the host holds nothing" and silently un-retire the
          // body's dirty mark.
          hostStateVectorBase64: null,
        },
      };
    case "doc-coverage-ack":
      return {
        kind: "room-event",
        event: {
          kind: "room-coverage",
          artifactRoomId: event.docId,
          coverageStateVectorBase64: event.coverageStateVectorBase64,
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
      // Independent of whether any bytes have arrived - "ready with no
      // snapshot" is a real state on this lane, and the `@1` arm reports its
      // rooms the same way. The tier's `"awaiting-seed"` lease arm is what
      // keeps that distinguishable from an empty body.
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
