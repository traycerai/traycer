/**
 * A body whose room leaves `ready` while a tile still holds it, and comes
 * back.
 *
 * ## The defect this pins
 *
 * A room leaving `ready` (a non-terminal `unavailable`, `terminal: false`)
 * runs `dropBodiesWhoseRoomIsGone`, which calls `bodyLeases.forget(docKey)`.
 * Before the fix, `forget` deleted the bridge's `entries` record for that
 * docKey and posted NOTHING to either side - it did not move the still-held
 * lease into `awaiting`, and it did not release the worker's retained demand
 * either. Two locks on the same door:
 *
 *   - `retryBodiesWhoseRoomBecameReady` only ever walks the bridge's
 *     `awaiting` map. A docKey `forget` had deleted outright was invisible to
 *     it, so the next `doc` frame for a room that came back never triggered a
 *     re-materialize.
 *   - Even if something else HAD asked again, `attachBodyObserver` used to
 *     early-return when a binding already existed for that docKey - but the
 *     `Y.Doc` it was bound to had just been destroyed
 *     (`tier.invalidate` -> `discardEverythingFor`). The observer stayed
 *     attached to a dead object, so a re-materialized replica's updates never
 *     reached main even in the one path that WOULD have re-asked.
 *
 * The symptom: a tile that never released its lease sat on "Reconnecting to
 * this document..." forever once its room flapped, even though the host went
 * on to serve the body again on the very next snapshot.
 *
 * The fix, read from the diff: `forget` now moves a still-held body back into
 * `awaiting` with its lease count intact (the same state a cold open is in),
 * so `retryBodiesWhoseRoomBecameReady` finds it the moment the room reads
 * `ready` again; and `attachBodyObserver` unconditionally detaches whatever
 * it was bound to before rebinding, so a re-materialized doc's updates always
 * reach the observer that is watching it now, not whichever one happened to
 * attach first.
 *
 * ## What each case pins
 *
 *   1. A still-held body re-materializes when its room becomes ready again -
 *      the `forget` -> `awaiting` -> retry path, driven end to end through the
 *      real store, host and (in-process) worker.
 *   2. The recovered body keeps receiving live updates - the OBSERVER-REBIND
 *      proof. Without it case 1 could pass on a re-materialize that installs
 *      once and then goes silent, which is indistinguishable from the fix at
 *      a single snapshot but is exactly the old defect one edit later.
 *   3 & 4. A lease that never comes back releases the worker's demand anyway
 *      - once from a fresh unmount, once from a lingering doc the drop
 *      catches before its cooldown would have. Both must reach zero WITHOUT
 *      the fix leaving a phantom holder that pins the subscription for the
 *      rest of the session.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
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
import { epicStatusSubscribeServerFrameSchemaV11 } from "@traycer/protocol/host/epic/status-subscribe";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { EpicLaneSelectionSources } from "@/stores/epics/open-epic/runtime/epic-replica-runtime";
import { encodeDocStateVectorBase64 } from "@/stores/epics/open-epic/runtime/dirty-watermark";
import { artifactBodyFragmentName } from "@traycer/protocol/persistence/epic/artifacts";
import { absentLaneUnaries } from "../test-support/absent-lane-unaries";

const ARTIFACT = "art-1";
const EPOCH = "epoch-1";
const DOC_GUID = "guid-1";

function statusSnapshot(): EpicStatusSnapshotFrame {
  const parsed = epicStatusSubscribeServerFrameSchemaV11.parse({
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

/** One tile's worth of leases: the two hooks `CollabTileBody` mounts. */
interface TileLeases {
  release(): void;
}

interface RecoveryRig {
  readonly handle: OpenedStoreForTest;
  announceEpoch(): Promise<void>;
  /** Mount a tile: BOTH hooks lease, exactly as `CollabTileBody` does. */
  mountTile(): Promise<TileLeases>;
  /** The host serves this body, full bytes under the given content. */
  seed(content: string): Promise<Y.Doc>;
  /**
   * A remote edit on the SAME document identity, expressed as a delta against
   * a state vector taken before the edit - the shape a live collaborator's
   * change actually takes on the wire.
   */
  deliverRemoteEdit(donor: Y.Doc, beforeEdit: Uint8Array): Promise<void>;
  /** The room leaves `ready` - a non-terminal `unavailable` on the open lane. */
  dropRoom(): Promise<void>;
  closeCount(): number;
  /** Whether the arm still holds an open subscription for the body. */
  subscriptionIsOpen(): boolean;
}

function createRecoveryRig(): RecoveryRig {
  let statusCallbacks: EpicStatusStreamCallbacks | null = null;
  let bodyCallbacks: ArtifactStreamCallbacks | null = null;
  let subscribes = 0;
  let closes = 0;

  const statusFactory: EpicStatusStreamClientFactory = (_epicId, cbs) => {
    statusCallbacks = cbs;
    return { close: () => undefined };
  };
  const stateFactory: EpicStateStreamClientFactory = () => ({
    close: () => undefined,
  });
  const artifactFactory: ArtifactStreamClientFactory = ({ callbacks }) => {
    subscribes += 1;
    bodyCallbacks = callbacks;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      // COUNTED: "the demand came off" is a claim about something NOT
      // happening on its own, and a close is the only event that could
      // falsify it.
      close: () => {
        closes += 1;
      },
    };
  };

  const laneSelection: EpicLaneSelectionSources = {
    support: () => "unknown",
    subscribeSupport: () => () => {},
    unaries: absentLaneUnaries(),
    stateStreamClientFactory: stateFactory,
    statusStreamClientFactory: statusFactory,
    artifactStreamClientFactory: artifactFactory,
  };

  const handle = openStoreForTest({
    epicId: "epic-room-leaves-ready-recovery",
    userId: null,
    factories: {
      streamClientFactory: () => {
        throw new Error("the legacy stream must not open on the lane arm");
      },
      laneSelection,
    },
    writeCommand: null,
  });

  function liveStatus(): EpicStatusStreamCallbacks {
    if (statusCallbacks === null) throw new Error("no status client");
    return statusCallbacks;
  }

  function liveBody(): ArtifactStreamCallbacks {
    if (bodyCallbacks === null) throw new Error("no body lane was opened");
    return bodyCallbacks;
  }

  // Two drains, matching every other suite in this directory: the projection
  // lands on the first, and the re-materialize (or, here, the recovery
  // retry) it triggers is queued behind the drain that caused it.
  async function settle(): Promise<void> {
    await handle.flush();
    await handle.flush();
  }

  return {
    handle,
    async announceEpoch(): Promise<void> {
      liveStatus().onSnapshot(statusSnapshot(), true);
      await settle();
    },
    async mountTile(): Promise<TileLeases> {
      const state = handle.store.getState();
      // TWO, not one - the fragment hook and the awareness hook, exactly as
      // `CollabTileBody` takes them. Held for the whole test unless the case
      // itself releases them: the point is recovery of a lease that was NEVER
      // let go, which is what a mounted-and-still-open tile actually does.
      const releaseFragment = state.acquireArtifactBodyLease(ARTIFACT);
      const releaseAwareness = state.acquireArtifactBodyLease(ARTIFACT);
      await settle();
      return {
        release: () => {
          releaseFragment();
          releaseAwareness();
        },
      };
    },
    async seed(content: string): Promise<Y.Doc> {
      const donor = new Y.Doc();
      donor
        .getXmlFragment(artifactBodyFragmentName(ARTIFACT))
        .insert(0, [new Y.XmlText(content)]);
      const parsed = artifactSubscribeServerFrameSchemaV10.parse({
        kind: "doc",
        hasBinaryPayload: true,
        authorityEpoch: EPOCH,
        artifactId: ARTIFACT,
        docGuid: DOC_GUID,
        stateVectorBase64: encodeDocStateVectorBase64(donor),
      });
      if (parsed.kind !== "doc") {
        throw new Error(`expected a doc frame, got ${parsed.kind}`);
      }
      liveBody().onDoc(parsed, Y.encodeStateAsUpdate(donor));
      await settle();
      return donor;
    },
    async deliverRemoteEdit(
      donor: Y.Doc,
      beforeEdit: Uint8Array,
    ): Promise<void> {
      const parsed = artifactSubscribeServerFrameSchemaV10.parse({
        kind: "docUpdate",
        hasBinaryPayload: true,
        authorityEpoch: EPOCH,
        artifactId: ARTIFACT,
        docGuid: DOC_GUID,
      });
      if (parsed.kind !== "docUpdate") {
        throw new Error(`expected a docUpdate frame, got ${parsed.kind}`);
      }
      liveBody().onDocUpdate(parsed, Y.encodeStateAsUpdate(donor, beforeEdit));
      await settle();
    },
    async dropRoom(): Promise<void> {
      const parsed = artifactSubscribeServerFrameSchemaV10.parse({
        kind: "unavailable",
        hasBinaryPayload: false,
        authorityEpoch: EPOCH,
        artifactId: ARTIFACT,
        code: "bodyUnavailable",
        reason: "test: the room stopped being ready",
        // NON-TERMINAL. This is the defect's whole precondition: a terminal
        // refusal is a different (already-covered) recovery contract, and
        // "retrying" is the availability value a room flapping out of `ready`
        // actually produces (`lane-body-translation.ts`).
        terminal: false,
      });
      if (parsed.kind !== "unavailable") {
        throw new Error(`expected an unavailable frame, got ${parsed.kind}`);
      }
      liveBody().onUnavailable(parsed);
      await settle();
    },
    closeCount: () => closes,
    subscriptionIsOpen: () => subscribes > 0 && closes < subscribes,
  };
}

describe("a body whose room leaves ready while a lease is still held", () => {
  const opened: OpenedStoreForTest[] = [];

  afterEach(() => {
    for (const handle of opened.splice(0)) handle.dispose();
  });

  function rigUnderTest(): RecoveryRig {
    const rig = createRecoveryRig();
    opened.push(rig.handle);
    return rig;
  }

  it("a still-held body re-materializes when its room is ready again", async () => {
    const rig = rigUnderTest();
    await rig.announceEpoch();
    const tile = await rig.mountTile();

    await rig.seed("hello");
    const first = rig.handle.store.getState().getArtifactFragment(ARTIFACT);
    if (first === null) throw new Error("expected a materialized fragment");
    expect(first.toJSON()).toContain("hello");

    await rig.dropRoom();
    // THE REDDENING ASSERTION pre-fix: `forget` deleted the entry and posted
    // nothing, so nothing here would ever ask for this body again - the
    // fragment goes null and stays null.
    expect(
      rig.handle.store.getState().getArtifactFragment(ARTIFACT),
    ).toBeNull();
    expect(
      rig.handle.store.getState().getArtifactBodyAvailability(ARTIFACT),
    ).toBe("retrying");

    // The SAME document identity, a fresh seed - the room coming back, not a
    // different document arriving under this artifact's id.
    await rig.seed("recovered");

    const recovered = rig.handle.store.getState().getArtifactFragment(ARTIFACT);
    if (recovered === null) {
      throw new Error("expected the body to be resident again");
    }
    expect(recovered.toJSON()).toContain("recovered");
    // NOT a merge of the old and new content: the tier destroyed the old
    // replica when the room left `ready` (`invalidate` keeps the doc's
    // identity but not its bytes), so a live-held lease recovering it gets
    // a FRESH document seeded from this snapshot alone.
    expect(recovered.toJSON()).not.toContain("hello");

    tile.release();
  });

  it("the recovered body keeps receiving live updates", async () => {
    // The observer-rebind proof. A re-materialize that installs once and then
    // goes silent is indistinguishable from case 1 above at a single
    // snapshot, and is exactly what the old `attachBodyObserver` early-return
    // produced: bound to a `Y.Doc` the tier had already destroyed, so a
    // second recovery's updates never reached main.
    const rig = rigUnderTest();
    await rig.announceEpoch();
    const tile = await rig.mountTile();

    await rig.seed("hello");
    await rig.dropRoom();
    const donor = await rig.seed("recovered");

    const beforeEdit = Y.encodeStateVector(donor);
    // Appended as a SECOND child, not spliced into the first text node's
    // characters: a `Y.XmlFragment`'s insert index counts children, and the
    // seed above is a single `Y.XmlText` occupying index 0.
    donor
      .getXmlFragment(artifactBodyFragmentName(ARTIFACT))
      .insert(1, [new Y.XmlText(" plus a live edit")]);
    await rig.deliverRemoteEdit(donor, beforeEdit);

    const fragment = rig.handle.store.getState().getArtifactFragment(ARTIFACT);
    if (fragment === null) throw new Error("expected a materialized fragment");
    expect(fragment.toJSON()).toContain("recovered");
    expect(fragment.toJSON()).toContain("plus a live edit");

    tile.release();
  });

  it("unmounting after the drop releases the worker's demand", async () => {
    const rig = rigUnderTest();
    await rig.announceEpoch();
    const tile = await rig.mountTile();

    await rig.seed("hello");
    expect(rig.subscriptionIsOpen()).toBe(true);

    await rig.dropRoom();

    // THE REDDENING ASSERTION pre-fix: `forget` posted nothing on either
    // side, so this holder's release found no accounting to decrement and
    // the subscription stayed open for the rest of the session even though
    // nothing is mounted to use it any more.
    tile.release();
    await rig.handle.flush();

    expect(rig.subscriptionIsOpen()).toBe(false);
    expect(rig.closeCount()).toBe(1);
  });

  it("a lingering body whose room leaves ready releases its demand", async () => {
    const rig = rigUnderTest();
    await rig.announceEpoch();
    const tile = await rig.mountTile();

    await rig.seed("hello");

    // Released while the room is STILL ready: this arms the cooldown rather
    // than posting anything immediately - the doc stays hot, on the bet that
    // the same lease comes back soon. Deliberately no timer is advanced: the
    // point of this case is that the room leaving `ready` must not wait for
    // that cooldown to notice demand is gone.
    tile.release();
    await rig.handle.flush();
    expect(rig.subscriptionIsOpen()).toBe(true);

    await rig.dropRoom();

    expect(rig.subscriptionIsOpen()).toBe(false);
    expect(rig.closeCount()).toBe(1);
  });
});
