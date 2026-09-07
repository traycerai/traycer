/**
 * Concurrent body leases for one artifact, over a bridge that does not settle
 * each call before the next caller starts.
 *
 * ## CHARACTERIZATION, not the regression test
 *
 * The queued bridge gets four acquires outstanding together, which the sync
 * pipe cannot - but `flush()` then drains them ATOMICALLY, delivering all four
 * answers in one round, so the count rises cleanly to four and this suite is
 * green with the fix ablated. It is kept for what it states through the real
 * store, host and core: the lane survives an earlier mount's releases, and it
 * still closes once every holder has let go. The regression test is
 * `runtime/worker/__tests__/artifact-body-lease-concurrent-acquire.test.ts`,
 * which parks each `body/materialize` individually and drives the bridge whose
 * ledger is wrong directly. Ablate the fix there, not here.
 *
 * ## The defect this describes (epic-sync-overhaul finding 11)
 *
 * A tile takes TWO body leases - `useEpicArtifactFragment` and
 * `useEpicArtifactBodyAwareness` each call `useEpicArtifactBodyLease` - and the
 * canvas remounts it during boot, so four acquires for one artifact are in
 * flight at once. Measured in the running app:
 *
 *   +7551  four concurrent `body/materialize`, `awaiting` map still EMPTY
 *   +7551  the worker discards the duplicate demand each one took
 *   +7625  an awaiting entry is created ... and immediately destroyed
 *   +7626  an early holder's `body/release` lands -> demand 0 -> lane closed
 *   +7629  the count finally reaches 2, three milliseconds too late
 *
 * The ledger is not mis-counting. It is being BUILT AND TORN DOWN concurrently
 * with the releases that read it, so a release belonging to a holder that has
 * gone can close the subscription out from under holders that are still
 * mounted. On the lane arm the subscription IS the body, so the tile is left on
 * the absent-key `"unavailable"` default with nothing to retry it.
 *
 * ## Why it needs the QUEUED bridge
 *
 * On the sync pipe every `body/materialize` is answered before the next caller
 * starts, so the second acquire sees an entry that in production does not exist
 * yet - the harness serializes what the field runs in parallel. A pin written
 * over the sync pipe passed WITH THE FIX ABLATED, which is what sent this back
 * for a second diagnosis. `openStoreForTestWithQueuedBridge` is the same host,
 * core and dispatch with `flush()` as the only thing that moves a frame, so the
 * four calls really are outstanding together.
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
  openStoreForTestWithQueuedBridge,
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

interface ConcurrentRig {
  readonly handle: OpenedStoreForTest;
  announceEpoch(): Promise<void>;
  /** Two leases, taken WITHOUT letting the pipe settle between them. */
  mountTile(): readonly (() => void)[];
  /** Let every outstanding call and its consequences land. */
  settle(): Promise<void>;
  seed(): Promise<void>;
  subscribeCount(): number;
  subscriptionIsOpen(): boolean;
}

function createConcurrentRig(): ConcurrentRig {
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

  const handle = openStoreForTestWithQueuedBridge({
    epicId: "epic-concurrent-acquire",
    userId: null,
    factories: {
      streamClientFactory: () => {
        throw new Error("the legacy stream must not open on the lane arm");
      },
      laneSelection,
    },
    writeCommand: null,
  });

  async function settle(): Promise<void> {
    // Twice, because a delivery can cause another: the answer to a materialize
    // is posted from a promise handler, and a retry it triggers is queued
    // behind the drain that caused it.
    await handle.flush();
    await handle.flush();
  }

  return {
    handle,
    async announceEpoch(): Promise<void> {
      if (statusCallbacks === null) throw new Error("no status client");
      statusCallbacks.onSnapshot(statusSnapshot());
      await settle();
    },
    mountTile(): readonly (() => void)[] {
      const state = handle.store.getState();
      // NO settle between them, and none after: both calls are outstanding
      // when this returns, which is the whole point.
      return [
        state.acquireArtifactBodyLease(ARTIFACT),
        state.acquireArtifactBodyLease(ARTIFACT),
      ];
    },
    settle,
    async seed(): Promise<void> {
      if (bodyCallbacks === null) throw new Error("no body lane was opened");
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
      bodyCallbacks.onDoc(parsed, Y.encodeStateAsUpdate(donor));
      await settle();
    },
    subscribeCount: () => subscribes,
    subscriptionIsOpen: () => subscribes > 0 && closes < subscribes,
  };
}

describe("concurrent body leases for one artifact", () => {
  const opened: OpenedStoreForTest[] = [];

  afterEach(() => {
    for (const handle of opened.splice(0)) handle.dispose();
  });

  function rigUnderTest(): ConcurrentRig {
    const rig = createConcurrentRig();
    opened.push(rig.handle);
    return rig;
  }

  it("keeps the lane open for still-mounted holders when an earlier mount's releases land", async () => {
    const rig = rigUnderTest();
    await rig.announceEpoch();

    // THE FIELD INTERLEAVE: four acquires outstanding together, none of them
    // answered, so none can see an entry the others have not installed yet.
    const firstMount = rig.mountTile();
    const secondMount = rig.mountTile();

    // THE INTERLEAVE, and the reason this is not `settle(); release(); settle()`:
    // in the field the first mount's releases were posted while the later
    // mounts' materializes were STILL OUTSTANDING (acquires at +7551/+7568,
    // entries installed at +7625, releases landing at +7626 among them). So the
    // release is issued here, before anything has been answered - which is also
    // the standing edge case "a holder releases while the materialize is still
    // in flight".
    for (const release of firstMount) release();
    await rig.settle();

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

    for (const release of secondMount) release();
  });

  it("still closes the lane once every concurrent holder has released", async () => {
    // The counterpart, and the reason this is a counting fix rather than a
    // never-close one: coalescing to a single subscription is correct and is
    // kept. A fix that simply stopped decrementing would leak a subscription
    // per artifact ever opened, and would pass the case above.
    const rig = rigUnderTest();
    await rig.announceEpoch();

    const firstMount = rig.mountTile();
    const secondMount = rig.mountTile();
    await rig.settle();

    for (const release of [...firstMount, ...secondMount]) release();
    await rig.settle();

    expect(rig.subscriptionIsOpen()).toBe(false);
  });
});
