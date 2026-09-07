/**
 * `artifact.subscribe@1.0`'s body events (`DocReplicaEvent`) in the rooms
 * replica's vocabulary.
 *
 * Three things are pinned here because getting them wrong fails silently:
 *
 *  - `doc-snapshot`'s `seed` and `docGuid` are FORWARDED, not decided here -
 *    they are the pair the artifact-body tier's merge-vs-seed-vs-replace rule
 *    reads.
 *  - EVERY event carrying a guid forwards it, not only the snapshot.
 *    `doc-update` and `doc-coverage-ack` both do, and both used to drop it -
 *    which left the replica unable to reject a frame from a generation a
 *    reseed had replaced. `DocUpdateEvent.docGuid` states whose check that is
 *    ("the replica - not the adapter - owns the drop"), so a translation that
 *    drops the guid is the adapter quietly deciding not to have one.
 *  - `doc-update` always forces `hostStateVectorBase64` to `null`, because a
 *    `""` here would read as "the host holds nothing" and silently un-retire
 *    the body's dirty mark.
 *  - `doc-unavailable`'s `"stale-authority-epoch"` code is NOT an
 *    availability state - it means the whole epic replica must be replaced,
 *    and folding it into `"unavailable"` would leave the epic silently stale
 *    while one tile merely greyed out.
 *
 * `artifactRoomId` is this arm's name for an ARTIFACT id (see the production
 * file's module doc): every translated room event carries the source event's
 * `docId` under that key.
 */
import { describe, expect, it } from "vitest";
import type {
  DocAwarenessEvent,
  DocCoverageAckEvent,
  DocReadyEvent,
  DocReplicaEvent,
  DocSeedMode,
  DocSnapshotEvent,
  DocUnavailableCode,
  DocUnavailableEvent,
  DocUpdateEvent,
} from "@traycer-clients/shared/replica-runtime";
import { laneBodyTranslationOf } from "../lane-body-translation";

const DOC_ID = "artifact-42";
const AUTHORITY_EPOCH = "epoch-1";
const UPDATE_BYTES = new Uint8Array([1, 2, 3]);
const FRAME_BYTES = new Uint8Array([9, 9]);

function docSnapshot(
  seed: DocSeedMode,
  docGuid: string,
  hostStateVectorBase64: string | null,
): DocSnapshotEvent {
  return {
    kind: "doc-snapshot",
    authorityEpoch: AUTHORITY_EPOCH,
    docId: DOC_ID,
    docGuid,
    update: UPDATE_BYTES,
    hostStateVectorBase64,
    seed,
  };
}

function docUpdate(): DocUpdateEvent {
  return {
    kind: "doc-update",
    authorityEpoch: AUTHORITY_EPOCH,
    docId: DOC_ID,
    docGuid: "guid-update",
    update: UPDATE_BYTES,
  };
}

function docCoverageAck(
  coverageStateVectorBase64: string,
): DocCoverageAckEvent {
  return {
    kind: "doc-coverage-ack",
    authorityEpoch: AUTHORITY_EPOCH,
    docId: DOC_ID,
    docGuid: "guid-coverage",
    coverageStateVectorBase64,
  };
}

function docAwareness(): DocAwarenessEvent {
  return {
    kind: "doc-awareness",
    authorityEpoch: AUTHORITY_EPOCH,
    docId: DOC_ID,
    frame: FRAME_BYTES,
  };
}

function docReady(): DocReadyEvent {
  return {
    kind: "doc-ready",
    authorityEpoch: AUTHORITY_EPOCH,
    docId: DOC_ID,
  };
}

function docUnavailable(
  code: DocUnavailableCode,
  terminal: boolean,
): DocUnavailableEvent {
  return {
    kind: "doc-unavailable",
    authorityEpoch: AUTHORITY_EPOCH,
    docId: DOC_ID,
    code,
    terminal,
    reason: "test reason",
  };
}

describe("totality over the six DocReplicaEvent members - a switch that fell through would return undefined", () => {
  it("produces a defined result for every member", () => {
    const events: readonly DocReplicaEvent[] = [
      docSnapshot("full", "guid-totality", "vector-totality"),
      docUpdate(),
      docCoverageAck("coverage-totality"),
      docAwareness(),
      docReady(),
      docUnavailable("body-unavailable", true),
    ];
    for (const event of events) {
      expect(laneBodyTranslationOf(event)).toBeDefined();
    }
  });
});

describe("doc-snapshot forwards seed and docGuid unchanged - the artifact-body tier's merge-vs-seed-vs-replace rule reads them", () => {
  it('forwards seed: "full", docGuid and the host vector exactly, with the id mapped to artifactRoomId', () => {
    expect(
      laneBodyTranslationOf(
        docSnapshot("full", "guid-full", "host-vector-abc"),
      ),
    ).toEqual({
      kind: "room-event",
      event: {
        kind: "room-snapshot",
        artifactRoomId: DOC_ID,
        update: UPDATE_BYTES,
        hostStateVectorBase64: "host-vector-abc",
        seed: "full",
        docGuid: "guid-full",
      },
    });
  });

  it('forwards seed: "delta-against-offer" and docGuid exactly', () => {
    expect(
      laneBodyTranslationOf(
        docSnapshot("delta-against-offer", "guid-delta", "host-vector-def"),
      ),
    ).toEqual({
      kind: "room-event",
      event: {
        kind: "room-snapshot",
        artifactRoomId: DOC_ID,
        update: UPDATE_BYTES,
        hostStateVectorBase64: "host-vector-def",
        seed: "delta-against-offer",
        docGuid: "guid-delta",
      },
    });
  });

  it('keeps a null host state vector null, never "" - a host that holds nothing must not be un-said', () => {
    const translated = laneBodyTranslationOf(
      docSnapshot("full", "guid-null-vector", null),
    );
    if (
      translated.kind !== "room-event" ||
      translated.event.kind !== "room-snapshot"
    ) {
      throw new Error("expected a room-snapshot event");
    }
    expect(translated.event.hostStateVectorBase64).toBe(null);
  });
});

describe("doc-update translates to hostStateVectorBase64: null, always - this wire carries no vector", () => {
  it("translates the update and forces the vector to null, with the id mapped", () => {
    expect(laneBodyTranslationOf(docUpdate())).toEqual({
      kind: "room-event",
      event: {
        kind: "room-update",
        artifactRoomId: DOC_ID,
        update: UPDATE_BYTES,
        hostStateVectorBase64: null,
        docGuid: "guid-update",
      },
    });
  });

  it("FORWARDS the doc guid, which is what lets the replica drop a superseded update", () => {
    // `DocUpdateEvent.docGuid` is required and its own doc names the owner of
    // the drop: "the replica - not the adapter - owns the drop", because
    // leaving the guid off the event "would push a core replica invariant into
    // every adapter, where it would be enforced three times and eventually
    // only twice". Dropping it HERE was that prediction coming true - a
    // delayed update from a generation a reseed had replaced reached
    // `ArtifactRoomTier.applyUpdate` with nothing left to compare against, and
    // `Y.applyUpdate` spliced two histories that share no ancestor.
    const translated = laneBodyTranslationOf(docUpdate());
    if (
      translated.kind !== "room-event" ||
      translated.event.kind !== "room-update"
    ) {
      throw new Error("expected a room-update event");
    }
    expect(translated.event.docGuid).toBe("guid-update");
  });

  it('the vector is explicitly null, not merely falsy - "" would silently un-retire the dirty mark', () => {
    const translated = laneBodyTranslationOf(docUpdate());
    if (
      translated.kind !== "room-event" ||
      translated.event.kind !== "room-update"
    ) {
      throw new Error("expected a room-update event");
    }
    expect(translated.event.hostStateVectorBase64).toBe(null);
  });
});

describe("doc-coverage-ack becomes room-coverage, carrying the coverage vector unchanged - the only event that retires local divergence on this arm", () => {
  it("translates with the coverage vector forwarded and the id mapped", () => {
    expect(
      laneBodyTranslationOf(docCoverageAck("coverage-vector-xyz")),
    ).toEqual({
      kind: "room-event",
      event: {
        kind: "room-coverage",
        artifactRoomId: DOC_ID,
        coverageStateVectorBase64: "coverage-vector-xyz",
        docGuid: "guid-coverage",
      },
    });
  });

  it("FORWARDS the doc guid, for a loss that is quieter than a spliced update", () => {
    // Coverage retires the dirty watermark, so an ack accepted from a
    // superseded generation marks the CURRENT document's unsent edits as
    // durable when the host has never seen them - they leave the divergence
    // accounting while existing nowhere but this tab. No splice, no visible
    // corruption, and the edits are simply gone on the next reload.
    const translated = laneBodyTranslationOf(docCoverageAck("v"));
    if (
      translated.kind !== "room-event" ||
      translated.event.kind !== "room-coverage"
    ) {
      throw new Error("expected a room-coverage event");
    }
    expect(translated.event.docGuid).toBe("guid-coverage");
  });
});

describe("doc-awareness is a straightforward rename with the frame forwarded unchanged", () => {
  it("translates to room-awareness with the frame and id mapped", () => {
    expect(laneBodyTranslationOf(docAwareness())).toEqual({
      kind: "room-event",
      event: {
        kind: "room-awareness",
        artifactRoomId: DOC_ID,
        frame: FRAME_BYTES,
      },
    });
  });
});

describe('doc-ready becomes room-availability: "ready", independent of whether any bytes arrived', () => {
  it("translates on its own with no snapshot fixture preceding it - ready-with-no-snapshot is a real reachable state", () => {
    expect(laneBodyTranslationOf(docReady())).toEqual({
      kind: "room-event",
      event: {
        kind: "room-availability",
        artifactRoomId: DOC_ID,
        availability: "ready",
      },
    });
  });
});

describe("doc-unavailable / stale-authority-epoch: replace-replica, never an availability event", () => {
  it("returns replace-replica when terminal is true, and it is not a room-event", () => {
    const translated = laneBodyTranslationOf(
      docUnavailable("stale-authority-epoch", true),
    );
    expect(translated).toEqual({ kind: "replace-replica" });
    expect(translated.kind).not.toBe("room-event");
  });

  it("returns replace-replica when terminal is false too - the CODE decides here, not terminal", () => {
    const translated = laneBodyTranslationOf(
      docUnavailable("stale-authority-epoch", false),
    );
    expect(translated).toEqual({ kind: "replace-replica" });
    expect(translated.kind).not.toBe("room-event");
  });
});

describe("doc-unavailable / body-unavailable: availability follows terminal", () => {
  it("terminal: true reads as unavailable", () => {
    expect(
      laneBodyTranslationOf(docUnavailable("body-unavailable", true)),
    ).toEqual({
      kind: "room-event",
      event: {
        kind: "room-availability",
        artifactRoomId: DOC_ID,
        availability: "unavailable",
      },
    });
  });

  it("terminal: false reads as retrying", () => {
    expect(
      laneBodyTranslationOf(docUnavailable("body-unavailable", false)),
    ).toEqual({
      kind: "room-event",
      event: {
        kind: "room-availability",
        artifactRoomId: DOC_ID,
        availability: "retrying",
      },
    });
  });
});

describe("doc-unavailable / artifact-not-found: not special-cased by code - availability follows terminal exactly like body-unavailable", () => {
  it("terminal: true reads as unavailable", () => {
    expect(
      laneBodyTranslationOf(docUnavailable("artifact-not-found", true)),
    ).toEqual({
      kind: "room-event",
      event: {
        kind: "room-availability",
        artifactRoomId: DOC_ID,
        availability: "unavailable",
      },
    });
  });

  it('terminal: false reads as retrying, even though the code\'s own doc comment calls this code "Terminal"', () => {
    expect(
      laneBodyTranslationOf(docUnavailable("artifact-not-found", false)),
    ).toEqual({
      kind: "room-event",
      event: {
        kind: "room-availability",
        artifactRoomId: DOC_ID,
        availability: "retrying",
      },
    });
  });
});
