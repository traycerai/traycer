/**
 * `acquireResidentArtifactBodyLease`'s `resident` promise, against a REAL
 * store (`openStoreForTest`) rather than a fake `acquireResidentArtifactBodyLease`
 * - the round-2 pins all faked that member, which is why none of this class of
 * defect was caught.
 *
 * Two independent teardown windows the doc at `store.ts:207-209` claims
 * `resident` rejects for, and one of them cannot today:
 *
 *  - **release() after an `awaiting-seed` grant, before residency lands**
 *    (`store.ts:1149-1163`, `waitForBodyResidency`): `release()` only flips a
 *    local `released` flag; the `isReleased()` check lives INSIDE the
 *    `api.subscribe` callback, so it only fires on a LATER store notification
 *    - and releasing drops the demand, which is exactly when no seed and
 *    therefore no notification ever comes. This is the case that actually
 *    hangs.
 *  - **store `dispose()` while `awaiting-seed`**: nothing in `dispose()`
 *    rejects a pending residency waiter either.
 *
 * `release()` BEFORE the grant resolves is a DIFFERENT, already-correct case
 * (`store.ts:1185-1188`) - pinned here as a control, not as the fix.
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
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import { ArtifactBodyUnavailableError } from "@/lib/epic-replica-reads";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { EpicLaneSelectionSources } from "@/stores/epics/open-epic/runtime/epic-replica-runtime";
import { encodeDocStateVectorBase64 } from "@/stores/epics/open-epic/runtime/dirty-watermark";
import { artifactBodyFragmentName } from "@traycer/protocol/persistence/epic/artifacts";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { absentLaneUnaries } from "@/stores/epics/open-epic/test-support/absent-lane-unaries";

const ARTIFACT = "art-1";
const EPOCH = "epoch-1";

/** Races a promise against a short timer, so a genuine hang reddens fast. */
function raceAgainstHang(promise: Promise<unknown>): Promise<unknown> {
  return Promise.race([
    promise.then(
      () => "settled" as const,
      (cause: unknown) => cause,
    ),
    new Promise<"hung">((resolve) => {
      setTimeout(() => {
        resolve("hung");
      }, 250);
    }),
  ]);
}

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

interface LaneRig {
  readonly handle: OpenedStoreForTest;
  /** Install the lanes and mount a tile - the cold open, in that order. */
  open(): Promise<void>;
  /** The host finally serves this body. */
  seed(): Promise<void>;
  /** How many `artifact.subscribe` clients the arm has opened. */
  subscribeCount(): number;
}

/**
 * Copied from `lane-body-awaiting-seed.test.ts` per this suite's own guidance
 * - the construction that reaches an `"awaiting-seed"` grant, not a fresh
 * invention of one.
 */
function createLaneRig(epicId: string): LaneRig {
  let statusCallbacks: EpicStatusStreamCallbacks | null = null;
  let bodyCallbacks: ArtifactStreamCallbacks | null = null;
  let subscribes = 0;

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
      close: () => undefined,
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
    epicId,
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
    async open(): Promise<void> {
      if (statusCallbacks === null) throw new Error("no status client");
      statusCallbacks.onSnapshot(statusSnapshot());
      handle.store.getState().acquireArtifactBodyLease(ARTIFACT);
      await handle.flush();
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
      await handle.flush();
      await handle.flush();
    },
    subscribeCount: () => subscribes,
  };
}

function encodeBase64ForTests(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/** The shape `write-command-delivery.test.ts` uses to open a legacy-arm store. */
function legacySnapshotMeta(epicId: string): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: epicId,
      title: "Epic test",
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
    hostStateVectorBase64: encodeBase64ForTests(
      Y.encodeStateVector(new Y.Doc()),
    ),
  };
}

/** A legacy-arm store whose write/body gates are open, but no artifact exists. */
function openLegacyRigWithNoArtifact(epicId: string): OpenedStoreForTest {
  const factory: EpicStreamClientFactory = (_id, callbacks) => {
    callbacks.onConnectionStatus("open", null);
    callbacks.onSnapshot(
      legacySnapshotMeta(epicId),
      Y.encodeStateAsUpdate(new Y.Doc()),
    );
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    };
  };
  return openStoreForTest({
    epicId,
    userId: null,
    factories: { streamClientFactory: factory, laneSelection: null },
    writeCommand: null,
  });
}

describe("acquireResidentArtifactBodyLease teardown", () => {
  const opened: OpenedStoreForTest[] = [];

  afterEach(() => {
    for (const handle of opened.splice(0)) handle.dispose();
  });

  function rigUnderTest(epicId: string): LaneRig {
    const rig = createLaneRig(epicId);
    opened.push(rig.handle);
    return rig;
  }

  it("PIN 1 (RED) - release() after an awaiting-seed grant, before residency lands, rejects instead of hanging", async () => {
    const rig = rigUnderTest("epic-body-lease-release-after-grant");
    await rig.open();
    // Confirm we are genuinely in the awaiting-seed window before proceeding.
    expect(
      rig.handle.store.getState().getArtifactFragment(ARTIFACT),
    ).toBeNull();

    const lease = rig.handle.store
      .getState()
      .acquireResidentArtifactBodyLease(ARTIFACT, "linger");
    // Let the acquisition settle into "awaiting-seed" before releasing -
    // otherwise this collapses into pin 3's already-correct
    // release-before-grant case.
    await rig.handle.flush();
    lease.release();

    const outcome = await raceAgainstHang(lease.resident);
    // Red today: the `isReleased()` check only fires from a LATER store
    // notification, and releasing drops the demand - so no notification, and
    // no notification, ever comes. This races out at "hung".
    expect(outcome).toBeInstanceOf(ArtifactBodyUnavailableError);
  });

  it("PIN 2 (RED) - store dispose() during an awaiting-seed wait rejects instead of hanging", async () => {
    const rig = rigUnderTest("epic-body-lease-dispose-during-await");
    await rig.open();
    expect(
      rig.handle.store.getState().getArtifactFragment(ARTIFACT),
    ).toBeNull();

    const lease = rig.handle.store
      .getState()
      .acquireResidentArtifactBodyLease(ARTIFACT, "linger");
    await rig.handle.flush();
    rig.handle.dispose();

    const outcome = await raceAgainstHang(lease.resident);
    expect(outcome).toBeInstanceOf(ArtifactBodyUnavailableError);
  });

  it("PIN 2b (RED) - a bridge disposed with the materialize still in flight is reported as an unavailable body, not as a bridge error", async () => {
    const rig = rigUnderTest("epic-body-lease-bridge-disposed-in-flight");
    await rig.open();

    const lease = rig.handle.store
      .getState()
      .acquireResidentArtifactBodyLease(ARTIFACT, "linger");
    // NOT flushed, deliberately - this is the one window pins 1 and 2 cannot
    // reach. They both let the acquire settle into `awaiting-seed` first; here
    // `body/materialize` is still on the wire when the bridge goes away, so
    // `acquire()` REJECTS rather than answering a grant.
    rig.handle.dispose();

    const outcome = await raceAgainstHang(lease.resident);
    // Red before the mapping as `expected BridgeDisposedError to be an instance
    // of ArtifactBodyUnavailableError`. It is not cosmetic: this rejection is
    // what `holdArtifactBody` propagates to the export mutation, so unconverted
    // the toast read "The runtime worker bridge was disposed with calls in
    // flight." instead of "'X' is still loading."
    expect(outcome).toBeInstanceOf(ArtifactBodyUnavailableError);
  });

  it("PIN 3 (CONTROL, green both sides) - release() BEFORE the grant resolves rejects immediately - the already-correct arm (store.ts:1185-1188)", async () => {
    const rig = rigUnderTest("epic-body-lease-release-before-grant");

    const lease = rig.handle.store
      .getState()
      .acquireResidentArtifactBodyLease(ARTIFACT, "linger");
    // Released in the SAME tick, before `acquire()`'s bridge round trip can
    // possibly answer - the `released` flag this rejects on is checked
    // synchronously inside the `.then` that runs when the grant lands, which
    // is a DIFFERENT code path from pins 1/2 above. A green result here
    // proves nothing about the fix; it is the case that already worked.
    lease.release();

    await expect(lease.resident).rejects.toBeInstanceOf(
      ArtifactBodyUnavailableError,
    );
  });

  it("PIN 4 (CONTROL, green both sides) - the sync member and the resident member for the same artifact make exactly ONE bridge acquire", async () => {
    const rig = rigUnderTest("epic-body-lease-one-acquire");
    const statusReady = rig.open();
    // Take BOTH members for the same artifact before the first has any chance
    // to answer, so a real double-demand would show up as two subscribes.
    rig.handle.store.getState().acquireArtifactBodyLease(ARTIFACT);
    const lease = rig.handle.store
      .getState()
      .acquireResidentArtifactBodyLease(ARTIFACT, "linger");
    await statusReady;
    await rig.handle.flush();

    // "Two acquires would be two demands" - `bodyLeases.acquire`'s own
    // coalescing (`artifact-body-lease-bridge.ts`) is what this pins: only
    // ONE `artifact.subscribe` reaches the lane, regardless of how many
    // holders joined the same in-flight acquire.
    expect(rig.subscribeCount()).toBe(1);

    lease.release();
  });

  it("PIN 5 (CONTROL, green both sides) - an awaiting-seed grant's resident RESOLVES when the residency bump lands", async () => {
    const rig = rigUnderTest("epic-body-lease-resolves-on-seed");
    await rig.open();

    const lease = rig.handle.store
      .getState()
      .acquireResidentArtifactBodyLease(ARTIFACT, "linger");
    await rig.handle.flush();

    await rig.seed();

    // This is what keeps pin 1 honest: without a case where `resident`
    // actually resolves, "rejects on release" and "rejects always" are
    // indistinguishable.
    await expect(lease.resident).resolves.toBeUndefined();
    expect(
      rig.handle.store.getState().getArtifactFragment(ARTIFACT),
    ).not.toBeNull();

    lease.release();
  });

  it("PIN 6 (CONTROL, green both sides) - an unavailable grant (no body for this artifact) rejects - store.ts:1182-1184", async () => {
    const handle = openLegacyRigWithNoArtifact("epic-body-lease-unavailable");
    opened.push(handle);

    const lease = handle.store
      .getState()
      .acquireResidentArtifactBodyLease("no-such-artifact", "linger");

    await expect(lease.resident).rejects.toBeInstanceOf(
      ArtifactBodyUnavailableError,
    );
  });
});
