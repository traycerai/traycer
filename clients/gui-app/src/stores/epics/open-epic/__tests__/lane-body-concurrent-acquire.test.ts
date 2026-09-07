/**
 * Concurrent body leases for one artifact, over a bridge that does not settle each call before the
 * next caller starts.
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
    // Twice, because a delivery can cause another: the answer to a materialize is posted from a
    // promise handler, and a retry it triggers is queued behind the drain that caused it.
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

    // THE INTERLEAVE, and the reason this is not `settle(); release(); settle()`: in the field the
    // first mount's releases were posted while the later mounts' materializes were STILL OUTSTANDING
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
    // The counterpart, and the reason this is a counting fix rather than a never-close one: coalescing
    // to a single subscription is correct and is kept.
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
