/**
 * A terminally-refused body lane, and the exact stimuli that may reattach it.
 *
 * ## The defect this pins (epic-sync-overhaul, finding 11's sibling)
 *
 * A terminal `unavailable` means "no further frames on THIS subscription". The
 * adapter records it and stops (`artifact-lane-adapter.ts`: "the consumer
 * reattaches with a new adapter if it still wants the body") - but nothing was
 * the consumer. Two locks on the same door:
 *
 *   1. Main's only re-drive for an awaiting body is
 *      `retryBodiesWhoseRoomBecameReady`, gated on the room reading `"ready"` -
 *      the outcome only a working lane produces. A refused room reads
 *      `"unavailable"` forever, so the gate is circular.
 *   2. Even a `ready`-independent trigger lands on `ensureAttached`'s
 *      `existing.authorityEpoch === authorityEpoch` early return, because the
 *      terminally-finished lane is never removed from `open`. Only `closeLane`
 *      deletes, and nothing called it on a terminal frame.
 *
 * So the tile sits on `"unavailable"` for the life of the session even after the
 * host would gladly serve the body, and only a fresh mount ever heals it.
 *
 * ## The contract, which is what this encodes
 *
 * A terminal refusal is honored FOR THE WORLD IT WAS ISSUED IN, and no further.
 * `terminal` is a fact about one subscription in one transport session at one
 * authority epoch - not a verdict about the body for all time.
 *
 * | Stimulus                                    | May reattach |
 * | ------------------------------------------- | ------------ |
 * | projection push / availability flap, same world | NO       |
 * | control frame at an unchanged epoch             | NO       |
 * | transport reconnect                             | ONCE     |
 * | authority-epoch change                          | ONCE     |
 * | a new demand (fresh acquire from a new mount)   | immediately |
 *
 * The negative case is not decoration. An availability transition is not new
 * information ABOUT THE REFUSAL, so reattaching on one both re-asks a host that
 * already said no and turns a steady refusal into a dial per push. The bound
 * that makes this safe is that every permitted stimulus is a real, rate-limited
 * event: once per reconnect, once per epoch change, once per mount.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type {
  ArtifactStreamClientFactory,
  EpicStateStreamClientFactory,
  EpicStatusStreamClientFactory,
} from "@traycer-clients/shared/epic-lanes";
import type {
  ArtifactStreamCallbacks,
  ArtifactUnavailableFrame,
} from "@traycer-clients/shared/host-transport/artifact-stream-client";
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
const NEXT_EPOCH = "epoch-2";

function statusSnapshot(
  authorityEpoch: string,
  dirty: boolean,
): EpicStatusSnapshotFrame {
  const parsed = epicStatusSubscribeServerFrameSchemaV10.parse({
    kind: "snapshot",
    hasBinaryPayload: false,
    authorityEpoch,
    securityEpoch: 1,
    permissionRole: "editor",
    cloudSyncStatus: "connected",
    // The only field varied between otherwise identical snapshots, so a repeat
    // genuinely publishes rather than being swallowed as unchanged - which is
    // what makes the negative case a real test of a real projection push.
    dirty,
    migration: null,
    deletion: { state: "none" },
  });
  if (parsed.kind !== "snapshot") {
    throw new Error(`expected a snapshot frame, got ${parsed.kind}`);
  }
  return parsed;
}

/**
 * `bodyUnavailable`, terminal - the host can serve the artifact but not its
 * body, and is finished trying on this subscription.
 *
 * Deliberately NOT `staleAuthorityEpoch`, which is terminal too but means
 * something else entirely: it voids the whole epic view and routes to
 * `requestReplacement`, so it never reaches the per-body path under test.
 */
function terminalRefusal(): ArtifactUnavailableFrame {
  const parsed = artifactSubscribeServerFrameSchemaV10.parse({
    kind: "unavailable",
    hasBinaryPayload: false,
    authorityEpoch: EPOCH,
    artifactId: ARTIFACT,
    code: "bodyUnavailable",
    reason: "host cannot materialize this body",
    terminal: true,
  });
  if (parsed.kind !== "unavailable") {
    throw new Error(`expected an unavailable frame, got ${parsed.kind}`);
  }
  return parsed;
}

interface RefusalRig {
  readonly handle: OpenedStoreForTest;
  announceEpoch(): Promise<void>;
  /** A tile mounts and KEEPS its leases for the whole test. */
  mountTile(): Promise<() => void>;
  /** The host refuses this body, terminally, on the lane that is open. */
  refuse(): Promise<void>;
  /** A transport reconnect on the control lane: the subscription's world ends. */
  reconnect(): Promise<void>;
  /** A control frame at an UNCHANGED epoch - a push, and nothing more. */
  pushUnchangedWorld(): Promise<void>;
  /** A control frame naming a NEW epoch. */
  announceNewEpoch(): Promise<void>;
  /** The host serves the body on whichever lane is currently open. */
  seed(authorityEpoch: string): Promise<void>;
  /** How many `artifact.subscribe` opens this arm has made, ever. */
  subscribeCount(): number;
}

function createRefusalRig(): RefusalRig {
  let statusCallbacks: EpicStatusStreamCallbacks | null = null;
  // The LATEST body callbacks, replaced on every reattach. A reattach hands the
  // arm a new subscription, and seeding through the old one proves nothing -
  // the adapter's generation guard drops those frames.
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
    epicId: "epic-terminal-refusal-recovery",
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

  // Twice, because a delivery can cause another: the projection lands on the
  // first drain, and the materialize it triggers is queued behind it.
  async function settle(): Promise<void> {
    await handle.flush();
    await handle.flush();
  }

  return {
    handle,
    async announceEpoch(): Promise<void> {
      liveStatus().onSnapshot(statusSnapshot(EPOCH, false));
      await settle();
    },
    async mountTile(): Promise<() => void> {
      const state = handle.store.getState();
      // TWO leases, as `CollabTileBody` takes: the fragment hook and the
      // awareness hook. Held for the whole test - the point is recovery WITHOUT
      // a fresh acquire, so a release here would hand the fix a stimulus the
      // contract already permits.
      const releaseFragment = state.acquireArtifactBodyLease(ARTIFACT);
      const releaseAwareness = state.acquireArtifactBodyLease(ARTIFACT);
      await settle();
      return () => {
        releaseFragment();
        releaseAwareness();
      };
    },
    async refuse(): Promise<void> {
      liveBody().onUnavailable(terminalRefusal());
      await settle();
    },
    async reconnect(): Promise<void> {
      const status = liveStatus();
      status.onConnectionStatus("reconnecting", null);
      await settle();
      status.onConnectionStatus("open", null);
      await settle();
    },
    async pushUnchangedWorld(): Promise<void> {
      // A control frame at the SAME epoch, twice, with a field varied so each
      // one really does publish a projection. This is the stimulus that must
      // change nothing.
      liveStatus().onSnapshot(statusSnapshot(EPOCH, true));
      await settle();
      liveStatus().onSnapshot(statusSnapshot(EPOCH, false));
      await settle();
    },
    async announceNewEpoch(): Promise<void> {
      liveStatus().onSnapshot(statusSnapshot(NEXT_EPOCH, false));
      await settle();
    },
    async seed(authorityEpoch: string): Promise<void> {
      const donor = new Y.Doc();
      donor
        .getXmlFragment(artifactBodyFragmentName(ARTIFACT))
        .insert(0, [new Y.XmlText("hello")]);
      const parsed = artifactSubscribeServerFrameSchemaV10.parse({
        kind: "doc",
        hasBinaryPayload: true,
        authorityEpoch,
        artifactId: ARTIFACT,
        docGuid: "guid-1",
        stateVectorBase64: encodeDocStateVectorBase64(donor),
      });
      if (parsed.kind !== "doc") {
        throw new Error(`expected a doc frame, got ${parsed.kind}`);
      }
      liveBody().onDoc(parsed, Y.encodeStateAsUpdate(donor));
      await settle();
    },
    subscribeCount: () => subscribes,
  };
}

describe("a body lane the host terminally refuses", () => {
  const opened: OpenedStoreForTest[] = [];

  afterEach(() => {
    for (const handle of opened.splice(0)) handle.dispose();
  });

  function rigUnderTest(): RefusalRig {
    const rig = createRefusalRig();
    opened.push(rig.handle);
    return rig;
  }

  it("reattaches once on a transport reconnect and materializes without a fresh acquire", async () => {
    const rig = rigUnderTest();
    await rig.announceEpoch();
    const release = await rig.mountTile();
    expect(rig.subscribeCount()).toBe(1);

    await rig.refuse();
    expect(
      rig.handle.store.getState().getArtifactBodyAvailability(ARTIFACT),
    ).toBe("unavailable");

    // THE EDGE. The subscription's world is gone, so the refusal it carried is
    // spent - and the tile is still mounted, so the body is still wanted.
    await rig.reconnect();
    expect(rig.subscribeCount()).toBe(2);

    // ...and the reattached lane must actually be wired through: the host
    // serves, and the body reaches the store with no second acquire anywhere.
    await rig.seed(EPOCH);
    expect(
      rig.handle.store.getState().getArtifactBodyAvailability(ARTIFACT),
    ).toBe("ready");
    const fragment = rig.handle.store.getState().getArtifactFragment(ARTIFACT);
    if (fragment === null) throw new Error("expected a materialized fragment");
    // The bytes really crossed - an empty fragment would satisfy a null check.
    expect(fragment.toJSON()).toContain("hello");

    release();
  });

  it("reattaches once on an authority-epoch change", async () => {
    // GREEN BEFORE THE FIX, and kept as a guard rather than a demonstration.
    // This edge already worked: a lane built under a superseded epoch fails
    // `existing.authorityEpoch === authorityEpoch`, so the corpse was closed
    // and rebuilt whether or not anyone had noticed it was finished. What the
    // fix could plausibly BREAK is exactly this - a refusal set that outlived
    // the epoch it was issued under would newly suppress a rebuild that has
    // always happened. That is what this holds down.
    const rig = rigUnderTest();
    await rig.announceEpoch();
    const release = await rig.mountTile();
    await rig.refuse();
    expect(rig.subscribeCount()).toBe(1);

    // The other edge the contract names, and a different mechanism: the lane
    // the refusal was issued on was built under an epoch nobody is serving now.
    await rig.announceNewEpoch();
    expect(rig.subscribeCount()).toBe(2);

    await rig.seed(NEXT_EPOCH);
    expect(
      rig.handle.store.getState().getArtifactBodyAvailability(ARTIFACT),
    ).toBe("ready");

    release();
  });

  it("does not reattach while the world is unchanged", async () => {
    // THE NEGATIVE, and the half that keeps the fix honest: a host that said no
    // must not be re-asked because a projection flushed. Without this a fix
    // could satisfy every case above by reattaching on any push, which is a
    // dial per projection against a host that is steadily refusing.
    const rig = rigUnderTest();
    await rig.announceEpoch();
    const release = await rig.mountTile();
    await rig.refuse();
    expect(rig.subscribeCount()).toBe(1);

    await rig.pushUnchangedWorld();
    await rig.pushUnchangedWorld();

    expect(rig.subscribeCount()).toBe(1);
    expect(
      rig.handle.store.getState().getArtifactBodyAvailability(ARTIFACT),
    ).toBe("unavailable");

    release();
  });

  it("waits for the NEXT edge when the reattached lane is refused again", async () => {
    // One re-drive per edge, not a retry loop that an edge merely starts. A
    // host that refuses on reconnect is asked again on the reconnect after
    // that, and at no point in between.
    const rig = rigUnderTest();
    await rig.announceEpoch();
    const release = await rig.mountTile();
    await rig.refuse();

    await rig.reconnect();
    expect(rig.subscribeCount()).toBe(2);

    await rig.refuse();
    await rig.pushUnchangedWorld();
    expect(rig.subscribeCount()).toBe(2);

    await rig.reconnect();
    expect(rig.subscribeCount()).toBe(3);

    release();
  });
});
