/**
 * A mounted tile ends up holding its body lease, and the lane it opened
 * survives long enough to dial and deliver.
 *
 * ## CHARACTERIZATION, not the regression test
 *
 * This suite is green with and without the finding-11 fix, and it is kept for
 * what it states rather than what it catches: that a remount holds its lane,
 * and that the lane still closes when every holder lets go - the two halves of
 * the refcount stated end to end, through the real store, host and core. The
 * defect itself needs delivery at FRAME granularity, which no full-stack
 * harness here can express (see below), so the regression test is
 * `runtime/worker/__tests__/artifact-body-lease-concurrent-acquire.test.ts`,
 * which drives the bridge whose ledger is wrong directly. Ablate the fix there,
 * not here.
 *
 * ## The defect this describes
 *
 * Measured in the running app (epic-sync-overhaul finding 11): a tile mounts,
 * `acquireArtifactBodyLease` runs, `ensureAttached` opens a lane, the
 * `artifact.subscribe` open crosses the worker bridge and main wires a real
 * session - and then the body demand falls to zero and `closeLane` tears the
 * session down ~2 ms later, BEFORE it ever dialled. Nothing goes on the wire,
 * so no room event is ever recorded, so the tile reads the absent-key default
 * `"unavailable"` forever. A later lease that is HELD heals it instantly.
 *
 * ## Why the existing suites miss it
 *
 * `lane-body-awaiting-seed.test.ts` is the closest neighbour and stays green:
 * it takes ONE lease and never lets go, which is the idealised mount. The field
 * path is not that. A tile takes TWO leases (`useEpicArtifactFragment` and
 * `useEpicArtifactBodyAwareness` each call `useEpicArtifactBodyLease`), and the
 * canvas remounts `CollabTileBody` during boot, so the real sequence is
 * acquire/acquire, release/release, acquire/acquire. That is the sequence
 * nothing covers, and it is the one that collapses the count.
 *
 * So both cases below drive the REFCOUNT, not just the happy single lease -
 * and neither pre-seeds the room, because a fixture that hands over bytes at
 * acquire time never exercises the window where the lane has to stay open on
 * its own.
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
import { epicStatusSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/epic/status-subscribe";
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

/** One tile's worth of leases: the two hooks `CollabTileBody` mounts. */
interface TileLeases {
  release(): void;
}

interface MountRig {
  readonly handle: OpenedStoreForTest;
  /** The status lane names the epoch bodies attach under. */
  announceEpoch(): void;
  /** Mount a tile: BOTH hooks lease, as `CollabTileBody` does. */
  mountTile(): Promise<TileLeases>;
  /** The host finally serves this body on the lane that is still open. */
  seed(): Promise<void>;
  subscribeCount(): number;
  /** Whether the arm still holds an open subscription for the body. */
  subscriptionIsOpen(): boolean;
}

function createMountRig(): MountRig {
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
      // COUNTED, because "the lane survived" is a claim about something NOT
      // happening, and the close is the only event that could falsify it.
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
    epicId: "epic-lease-survives-mount",
    userId: null,
    factories: {
      streamClientFactory: () => {
        throw new Error("the legacy stream must not open on the lane arm");
      },
      laneSelection,
    },
    writeCommand: null,
  });

  function liveBody(): ArtifactStreamCallbacks {
    if (bodyCallbacks === null) throw new Error("no body lane was opened");
    return bodyCallbacks;
  }

  return {
    handle,
    announceEpoch(): void {
      if (statusCallbacks === null) throw new Error("no status client");
      statusCallbacks.onSnapshot(statusSnapshot());
    },
    async mountTile(): Promise<TileLeases> {
      const state = handle.store.getState();
      // TWO, not one - the fragment hook and the awareness hook. A single
      // lease would settle the refcount at 1 no matter how the release
      // interleaves, which is exactly the shape that keeps the neighbouring
      // suite green over this defect.
      const releaseFragment = state.acquireArtifactBodyLease(ARTIFACT);
      const releaseAwareness = state.acquireArtifactBodyLease(ARTIFACT);
      await handle.flush();
      return {
        release: () => {
          releaseFragment();
          releaseAwareness();
        },
      };
    },
    async seed(): Promise<void> {
      const donor = new Y.Doc();
      donor
        .getXmlFragment(artifactBodyFragmentName(ARTIFACT))
        .insert(0, [new Y.XmlText("hello")]);
      const parsed = artifactSubscribeServerFrameSchemaV10.parse({
        kind: "doc",
        hasBinaryPayload: true,
        authorityEpoch: EPOCH,
        artifactId: ARTIFACT,
        docGuid: "guid-1",
        stateVectorBase64: encodeDocStateVectorBase64(donor),
      });
      if (parsed.kind !== "doc") {
        throw new Error(`expected a doc frame, got ${parsed.kind}`);
      }
      liveBody().onDoc(parsed, Y.encodeStateAsUpdate(donor));
      // Two drains, for the same reason the awaiting-seed suite names: the
      // projection lands on the first, and the re-materialize it triggers is
      // queued behind the drain that caused it.
      await handle.flush();
      await handle.flush();
    },
    subscribeCount: () => subscribes,
    subscriptionIsOpen: () => subscribes > 0 && closes < subscribes,
  };
}

describe("a body lease taken by a mounting tile", () => {
  const opened: OpenedStoreForTest[] = [];

  afterEach(() => {
    for (const handle of opened.splice(0)) handle.dispose();
  });

  function rigUnderTest(): MountRig {
    const rig = createMountRig();
    opened.push(rig.handle);
    return rig;
  }

  it("keeps the lane open for a still-mounted holder when the previous mount's releases land", async () => {
    const rig = rigUnderTest();
    rig.announceEpoch();

    // THE OBSERVED INTERLEAVE. The releases cross an async bridge hop, so the
    // previous mount's decrements arrive AFTER the next mount's increments -
    // measured in the running app as the last `willClose:true` landing 60 ms
    // after the final acquire. So the two mounts OVERLAP; the second is live
    // and on screen when the first one's releases come home.
    //
    // Releasing everything and only then remounting is a different sequence,
    // and one where closing the lane is CORRECT. Asserting against that would
    // pin a behaviour the code should keep.
    const firstMount = await rig.mountTile();
    const secondMount = await rig.mountTile();

    firstMount.release();
    await rig.handle.flush();

    // The tile that is still mounted holds two leases, so the body it is
    // showing must still be subscribed. Before the fix the second mount's
    // acquires were coalesced away without being counted, so these releases
    // decremented the only count there was and tore the lane down underneath
    // it - with no dial, no room event, and a tile left on the absent-key
    // default forever.
    expect(rig.subscriptionIsOpen()).toBe(true);
    expect(rig.subscribeCount()).toBe(1);

    await rig.seed();

    expect(
      rig.handle.store.getState().getArtifactBodyAvailability(ARTIFACT),
    ).toBe("ready");
    const fragment = rig.handle.store.getState().getArtifactFragment(ARTIFACT);
    if (fragment === null) throw new Error("expected a materialized fragment");
    // The bytes really crossed - an empty fragment would satisfy a null check.
    expect(fragment.toJSON()).toContain("hello");

    secondMount.release();
  });

  it("still closes the lane once EVERY holder has released", async () => {
    // The other side of the ledger, and the reason the fix is a counting
    // change rather than a "never close" change: coalescing to one
    // subscription is correct and is kept. A fix that simply stopped
    // decrementing would leak a subscription per artifact ever opened.
    const rig = rigUnderTest();
    rig.announceEpoch();

    const firstMount = await rig.mountTile();
    const secondMount = await rig.mountTile();

    firstMount.release();
    secondMount.release();
    await rig.handle.flush();

    expect(rig.subscriptionIsOpen()).toBe(false);
  });
});
