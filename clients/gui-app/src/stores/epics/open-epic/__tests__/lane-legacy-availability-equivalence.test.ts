import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type {
  ArtifactStreamClientFactory,
  EpicStateStreamClientFactory,
  EpicStatusStreamClientFactory,
} from "@traycer-clients/shared/epic-lanes";
import type { ArtifactStreamCallbacks } from "@traycer-clients/shared/host-transport/artifact-stream-client";
import type {
  EpicStatusSnapshotFrame,
  EpicStatusStreamCallbacks,
} from "@traycer-clients/shared/host-transport/epic-status-stream-client";
import { artifactSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/epic/artifact-subscribe";
import { epicStatusSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/epic/status-subscribe";
import {} from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { EpicLaneSelectionSources } from "@/stores/epics/open-epic/runtime/epic-replica-runtime";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/runtime/legacy-epic-stream-adapter";
import type { EpicArtifactRoomAvailability } from "@/stores/epics/open-epic/types";
import { encodeDocStateVectorBase64 } from "@/stores/epics/open-epic/runtime/dirty-watermark";
import { absentLaneUnaries } from "../test-support/absent-lane-unaries";

const ARTIFACT = "art-1";
const ROOM = "artifact-room-0";
const EPOCH = "epoch-1";

// ── Shared fixtures ─────────────────────────────────────────────────────────

function buildMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: "epic-a",
      title: "Epic A",
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      createdBy: "u",
      version: "1",
    },
    permissionRole: "editor",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    // REQUIRED and decoded by `ingestSnapshot`, so an empty string is a
    // malformed vector rather than an absent one.
    hostStateVectorBase64: encodeDocStateVectorBase64(new Y.Doc()),
  };
}

/** A root doc naming ONE artifact and the room its body lives in. */
function rootDocNamingArtifactRoom(): Uint8Array {
  const donor = new Y.Doc();
  const epicMap = donor.getMap<unknown>("epic");
  const artifacts = new Y.Map<unknown>();
  epicMap.set("artifacts", artifacts);
  const entry = new Y.Map<unknown>();
  entry.set("id", ARTIFACT);
  entry.set("kind", "spec");
  entry.set("title", "Spec One");
  entry.set("parentId", null);
  entry.set("createdAt", 0);
  entry.set("updatedAt", 0);
  entry.set("artifactRoomId", ROOM);
  artifacts.set(ARTIFACT, entry);
  return Y.encodeStateAsUpdate(donor);
}

// ── What every arm must be able to say ──────────────────────────────────────

/**
 * One arm, expressed as host INTENT. Every method is something the authority can state about a
 * body.
 */
interface AvailabilityArm {
  readonly handle: OpenedStoreForTest;
  /** Bring the session up to the point a tile could mount. */
  open(): void;
  /** The host is serving this body. */
  reportServing(): void;
  /** The host cannot serve it, and has given up. */
  reportGivenUp(): void;
  /** The host cannot serve it yet, and is still trying. */
  reportRetrying(): void;
  /** Drop and restore the sockets, keeping the replica - the retained handle. */
  cycleTransport(): void;
  /**
   * Put this arm back in a position to be told a GIVEN-UP body is serving. The one place the two
   * arms legitimately differ, so it is named here rather than smuggled into a row.
   */
  reopenAfterGivingUp(): void;
  /** The host refuses a lane this arm requires, or `null` when the arm has no such lane to refuse. */
  readonly refuseRequiredLane: (() => void) | null;
  /** How many times `@1` was opened. Only ever non-zero after a fallback. */
  legacyOpenCount(): number;
}

/** What the tile actually reads. Both readers, because both are consumed. */
function availabilityAsTileSeesIt(handle: OpenedStoreForTest): {
  readonly projected: EpicArtifactRoomAvailability | undefined;
  readonly derived: EpicArtifactRoomAvailability;
} {
  const state = handle.store.getState();
  return {
    projected: state.artifactRooms.stateByArtifactId[ARTIFACT],
    derived: state.getArtifactBodyAvailability(ARTIFACT),
  };
}

// ── The `@1` driver ─────────────────────────────────────────────────────────

function createLegacyArm(): AvailabilityArm {
  let callbacks: EpicStreamCallbacks | null = null;
  const factory: EpicStreamClientFactory = (_epicId, cbs) => {
    callbacks = cbs;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    };
  };
  const handle = openStoreForTest({
    epicId: "epic-availability-legacy",
    userId: null,
    // The factories go to the COMPOSITION now: the store stopped constructing a runtime, so a
    // `streamClientFactory` has nowhere else to go.
    factories: {
      streamClientFactory: factory,
      laneSelection: null,
    },
    writeCommand: null,
  });
  function live(): EpicStreamCallbacks {
    if (callbacks === null) throw new Error("no legacy stream client");
    return callbacks;
  }
  return {
    handle,
    open(): void {
      live().onConnectionStatus("open", null);
      // The snapshot is what names this artifact's ROOM. Without it the
      // fan-out has no mapping and no room frame could ever reach the tile.
      live().onSnapshot(buildMeta(), rootDocNamingArtifactRoom());
    },
    reportServing: () => live().onArtifactRoomState(ROOM, "ready"),
    reportGivenUp: () => live().onArtifactRoomState(ROOM, "unavailable"),
    reportRetrying: () => live().onArtifactRoomState(ROOM, "retrying"),
    cycleTransport(): void {
      live().onConnectionStatus("reconnecting", null);
      live().onConnectionStatus("open", null);
    },
    // NOTHING, and deliberately not "unimplemented".
    reopenAfterGivingUp: () => {},
    // `@1` has no lanes, so nothing to refuse. See the field's own doc.
    refuseRequiredLane: null,
    legacyOpenCount: () => 1,
  };
}

// ── The lane driver ─────────────────────────────────────────────────────────

function statusSnapshot(): EpicStatusSnapshotFrame {
  const parsed = epicStatusSubscribeServerFrameSchemaV10.parse({
    kind: "snapshot",
    hasBinaryPayload: false,
    authorityEpoch: EPOCH,
    securityEpoch: 1,
    permissionRole: "editor",
    cloudSyncStatus: "connected",
    dirty: false,
    migration: null,
    deletion: { state: "none" },
  });
  if (parsed.kind !== "snapshot") {
    throw new Error(`expected a snapshot frame, got ${parsed.kind}`);
  }
  return parsed;
}

function createLaneArm(): AvailabilityArm {
  let statusCallbacks: EpicStatusStreamCallbacks | null = null;
  let bodyCallbacks: ArtifactStreamCallbacks | null = null;
  /** How many `artifact.subscribe` opens this arm has made, ever. */
  let bodySubscribes = 0;
  let releaseLease: (() => void) | null = null;
  let legacyMayOpen = false;
  let legacyOpens = 0;

  const statusFactory: EpicStatusStreamClientFactory = (_epicId, cbs) => {
    statusCallbacks = cbs;
    return { close: () => undefined };
  };
  const stateFactory: EpicStateStreamClientFactory = () => ({
    close: () => undefined,
  });
  const artifactFactory: ArtifactStreamClientFactory = ({ callbacks: cbs }) => {
    bodySubscribes += 1;
    // RE-CAPTURED on every open, not latched on the first.
    bodyCallbacks = cbs;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      close: () => undefined,
    };
  };

  const laneSelection: EpicLaneSelectionSources = {
    // The relay shape: support never resolves.
    support: () => "unknown",
    subscribeSupport: () => () => {},
    unaries: absentLaneUnaries(),
    stateStreamClientFactory: stateFactory,
    statusStreamClientFactory: statusFactory,
    artifactStreamClientFactory: artifactFactory,
  };
  const handle = openStoreForTest({
    epicId: "epic-availability-lanes",
    userId: null,
    // The factories go to the COMPOSITION now: the store stopped constructing a runtime, so a
    // `streamClientFactory` has nowhere else to go.
    factories: {
      streamClientFactory: () => {
        if (!legacyMayOpen) {
          throw new Error(
            "the legacy stream must not open on the lane arm before a required lane is refused",
          );
        }
        legacyOpens += 1;
        return {
          applyUpdate: () => undefined,
          awareness: () => undefined,
          applyArtifactRoomUpdate: () => undefined,
          artifactRoomAwareness: () => undefined,
          retryMigration: () => undefined,
          close: () => undefined,
        };
      },
      laneSelection: laneSelection,
    },
    writeCommand: null,
  });

  function liveBody(): ArtifactStreamCallbacks {
    if (bodyCallbacks === null) throw new Error("no body lane was opened");
    return bodyCallbacks;
  }
  function unavailable(terminal: boolean): void {
    const parsed = artifactSubscribeServerFrameSchemaV10.parse({
      kind: "unavailable",
      hasBinaryPayload: false,
      authorityEpoch: EPOCH,
      artifactId: ARTIFACT,
      code: "bodyUnavailable",
      reason: "the host cannot materialise this body",
      terminal,
    });
    if (parsed.kind !== "unavailable") {
      throw new Error(`expected an unavailable frame, got ${parsed.kind}`);
    }
    liveBody().onUnavailable(parsed);
  }

  return {
    handle,
    open(): void {
      if (statusCallbacks === null) throw new Error("no status client");
      // Installs the lanes off the probe's outcome, and names the epoch a body
      // lane attaches under.
      statusCallbacks.onSnapshot(statusSnapshot());
      // The tile mounting is what opens the body lane on this arm.
      releaseLease = handle.store.getState().acquireArtifactBodyLease(ARTIFACT);
    },
    reportServing(): void {
      // A `doc` frame IS the host serving this body: the adapter emits `doc-ready` on the transition
      // into ready, which is the lane wire's equivalent of `@1`'s `onArtifactRoomState(room, "ready")`.
      const seed = new Y.Doc();
      const parsed = artifactSubscribeServerFrameSchemaV10.parse({
        kind: "doc",
        hasBinaryPayload: true,
        authorityEpoch: EPOCH,
        artifactId: ARTIFACT,
        docGuid: "guid-1",
        // A REAL vector. The schema accepts any string, but the tier decodes
        // it, so `""` is not "no vector" here - it is a malformed one.
        stateVectorBase64: encodeDocStateVectorBase64(seed),
      });
      if (parsed.kind !== "doc") {
        throw new Error(`expected a doc frame, got ${parsed.kind}`);
      }
      liveBody().onDoc(parsed, Y.encodeStateAsUpdate(seed));
    },
    reportGivenUp: () => unavailable(true),
    reportRetrying: () => unavailable(false),
    cycleTransport(): void {
      // The BODY lane's own socket, which is what the row using this is about: the retained handle
      // across a drop.
      liveBody().onConnectionStatus("reconnecting", null);
      liveBody().onConnectionStatus("open", null);
      if (releaseLease === null) throw new Error("no lease was taken");
    },
    reopenAfterGivingUp(): void {
      if (statusCallbacks === null) throw new Error("no status client");
      // THE CONTROL LANE, and it has to be this one.
      const before = bodySubscribes;
      statusCallbacks.onConnectionStatus("reconnecting", null);
      statusCallbacks.onConnectionStatus("open", null);
      // The lease is still held, so the reattach has a demand to satisfy - if
      // it did not, this would pass for the wrong reason.
      if (releaseLease === null) throw new Error("no lease was taken");
      // AND THE REATTACH REALLY HAPPENED.
      if (bodySubscribes <= before) {
        throw new Error(
          `the reconnect edge opened no new body subscription (still ${String(bodySubscribes)})`,
        );
      }
    },
    refuseRequiredLane(): void {
      // Falling back to `@1` IS the accepted answer here, so the guard is
      // lifted for exactly this transition and the open is then counted.
      legacyMayOpen = true;
      liveBody().onConnectionStatus("closed", {
        kind: "fatalError",
        details: {
          code: "INCOMPATIBLE",
          reason: "artifact.subscribe is not served by this host",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      });
    },
    legacyOpenCount: () => legacyOpens,
  };
}

// ── The table ───────────────────────────────────────────────────────────────

const ARMS: ReadonlyArray<{
  readonly name: string;
  readonly build: () => AvailabilityArm;
}> = [
  { name: "@1 (legacy)", build: createLegacyArm },
  { name: "lanes", build: createLaneArm },
];

describe.each(ARMS)("body availability is identical on $name", ({ build }) => {
  const opened: OpenedStoreForTest[] = [];

  afterEach(() => {
    for (const handle of opened.splice(0)) handle.dispose();
  });

  function armUnderTest(): AvailabilityArm {
    const arm = build();
    opened.push(arm.handle);
    arm.open();
    return arm;
  }

  it("a body the host is serving reads READY", () => {
    // Row 1, and the regression row.
    const arm = armUnderTest();
    arm.reportServing();

    expect(availabilityAsTileSeesIt(arm.handle)).toEqual({
      projected: "ready",
      derived: "ready",
    });
  });

  it("a body the host has given up on reads UNAVAILABLE", () => {
    const arm = armUnderTest();
    arm.reportGivenUp();

    expect(availabilityAsTileSeesIt(arm.handle)).toEqual({
      projected: "unavailable",
      derived: "unavailable",
    });
  });

  it("a body the host is still retrying reads RETRYING", () => {
    // The member that makes this a tri-state rather than a boolean: a tile
    // shows a transient state without tearing its editor down.
    const arm = armUnderTest();
    arm.reportRetrying();

    expect(availabilityAsTileSeesIt(arm.handle)).toEqual({
      projected: "retrying",
      derived: "retrying",
    });
  });

  it("a body the host has said NOTHING about reads unavailable - absence is not readiness", () => {
    const arm = armUnderTest();

    const seen = availabilityAsTileSeesIt(arm.handle);
    expect(seen.projected).toBeUndefined();
    expect(seen.derived).toBe("unavailable");
  });

  it("moves READY -> UNAVAILABLE -> READY, ending where it started", () => {
    // Transitions, not just resting values.
    const arm = armUnderTest();

    arm.reportServing();
    expect(availabilityAsTileSeesIt(arm.handle).derived).toBe("ready");

    arm.reportGivenUp();
    expect(availabilityAsTileSeesIt(arm.handle).derived).toBe("unavailable");

    arm.reopenAfterGivingUp();
    arm.reportServing();
    expect(availabilityAsTileSeesIt(arm.handle).derived).toBe("ready");
  });

  it("a refused required lane leaves the tile where a @1 session starts, not in an error state", () => {
    // VACUOUS ON `@1` BY CONSTRUCTION, and declared so rather than faked: the legacy arm is ONE
    // stream, so "a required lane is refused" is not a state it can reach.
    const arm = armUnderTest();
    if (arm.refuseRequiredLane === null) {
      expect(availabilityAsTileSeesIt(arm.handle).derived).toBe("unavailable");
      return;
    }
    arm.reportServing();
    expect(availabilityAsTileSeesIt(arm.handle).derived).toBe("ready");

    arm.refuseRequiredLane();

    // The fallback really happened - `@1` is now open.
    expect(arm.legacyOpenCount()).toBe(1);
    expect(availabilityAsTileSeesIt(arm.handle).derived).toBe("unavailable");
  });

  it("re-announces after the transport cycles, rather than latching the drop", () => {
    // The retained-handle path.
    const arm = armUnderTest();
    arm.reportServing();
    expect(availabilityAsTileSeesIt(arm.handle).derived).toBe("ready");

    arm.cycleTransport();
    arm.reportServing();

    expect(availabilityAsTileSeesIt(arm.handle)).toEqual({
      projected: "ready",
      derived: "ready",
    });
  });
});
