/**
 * The cold open on the lane arm, end to end: a tile mounts before the host has
 * sent a byte, and its body still arrives.
 *
 * ## The defect this pins
 *
 * On the lane arm `acquireArtifactBodyLease` IS the `artifact.subscribe` open -
 * "a body is not served until something asks for it", `epic-replica-runtime.ts`
 * - so the ordinary mount order is lease first, bytes later. The relocated
 * `body/materialize` took that lease, found nothing to hand over, and RELEASED,
 * which closed the subscription that was about to deliver the bytes. Nothing
 * retried: `useEpicArtifactBodyLease` keys its effect on
 * `[handle, artifactId, bodyDocKey]` and on this arm `bodyDocKey` IS the
 * artifact id, so it never moves. Every artifact body on the arm was
 * unreachable, and the six rows of
 * `lane-legacy-availability-equivalence.test.ts` were the same cause seen from
 * the availability side.
 *
 * ## Why it is pinned HERE rather than one layer down
 *
 * `epic-artifact-body-lanes.test.ts` drives the lanes module directly and was
 * green throughout; `epic-runtime-core-ports.test.ts` drives the ports and had
 * a pin asserting the release. Both were right about their own layer. What
 * nothing covered was the SEQUENCE across them - subscribe, wait, seed, install
 * - which is the only place the defect is visible.
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

interface LaneRig {
  readonly handle: OpenedStoreForTest;
  /** Install the lanes and mount a tile - the cold open, in that order. */
  open(): Promise<void>;
  /** The host finally serves this body. */
  seed(): Promise<void>;
  /** How many `artifact.subscribe` clients the arm has opened. */
  subscribeCount(): number;
  /** Whether the arm still holds an open subscription for the body. */
  subscriptionIsOpen(): boolean;
}

function createLaneRig(): LaneRig {
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
      // COUNTED, because "the subscription is still open" is a claim about
      // something NOT happening, and the close is the only event that could
      // falsify it.
      close: () => {
        closes += 1;
      },
    };
  };

  const laneSelection: EpicLaneSelectionSources = {
    // The relay shape: support never resolves, so the probe's own outcome is
    // what installs the lanes - the way a real remote connection reaches this
    // arm, rather than a manifest a test resolved by hand.
    support: () => "unknown",
    subscribeSupport: () => () => {},
    stateStreamClientFactory: stateFactory,
    statusStreamClientFactory: statusFactory,
    artifactStreamClientFactory: artifactFactory,
  };

  const handle = openStoreForTest({
    epicId: "epic-awaiting-seed",
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
      // The lease is a `body/materialize` CALL, so the answer - awaiting or
      // granted - lands a microtask later.
      await handle.flush();
    },
    async seed(): Promise<void> {
      const donor = new Y.Doc();
      // The fragment the STORE reads, composed from the protocol's own helper -
      // a hand-written name would seed a document the reader never looks at and
      // the pin would assert an empty fragment against an empty one.
      donor
        .getXmlFragment(artifactBodyFragmentName(ARTIFACT))
        .insert(0, [new Y.XmlText("hello")]);
      const parsed = artifactSubscribeServerFrameSchemaV10.parse({
        kind: "doc",
        hasBinaryPayload: true,
        authorityEpoch: EPOCH,
        artifactId: ARTIFACT,
        docGuid: "guid-1",
        // A REAL vector: the tier decodes it, so `""` would be a malformed one
        // rather than an absent one.
        stateVectorBase64: encodeDocStateVectorBase64(donor),
      });
      if (parsed.kind !== "doc") {
        throw new Error(`expected a doc frame, got ${parsed.kind}`);
      }
      liveBody().onDoc(parsed, Y.encodeStateAsUpdate(donor));
      // TWO drains, because the completion is genuinely two hops and saying so
      // is better than a loop that hides the count. The first delivers the
      // projection this frame produced (the room turns `ready`); the retry that
      // projection triggers issues its own `body/materialize` DURING that
      // delivery, so its answer is queued behind the drain that caused it.
      await handle.flush();
      await handle.flush();
    },
    subscribeCount: () => subscribes,
    subscriptionIsOpen: () => subscribes > 0 && closes < subscribes,
  };
}

describe("a body leased before its seed arrives", () => {
  const opened: OpenedStoreForTest[] = [];

  afterEach(() => {
    for (const handle of opened.splice(0)) handle.dispose();
  });

  function rigUnderTest(): LaneRig {
    const rig = createLaneRig();
    opened.push(rig.handle);
    return rig;
  }

  it("keeps its subscription open through the wait, and materializes when the frame lands", async () => {
    const rig = rigUnderTest();
    await rig.open();

    // THE WAIT. One subscription opened, still open, and nothing on main yet -
    // which is the honest state rather than a failure. Before the fix the
    // subscription was already closed at this exact point, by the materialize
    // that opened it.
    expect(rig.subscribeCount()).toBe(1);
    expect(rig.subscriptionIsOpen()).toBe(true);
    expect(
      rig.handle.store.getState().getArtifactFragment(ARTIFACT),
    ).toBeNull();

    await rig.seed();

    // THE COMPLETION. The projection's `ready` is what drives the re-materialize,
    // and the doc arrives with its identity intact - which is why this is a
    // re-call rather than a pushed seed.
    expect(
      rig.handle.store.getState().getArtifactBodyAvailability(ARTIFACT),
    ).toBe("ready");
    const fragment = rig.handle.store.getState().getArtifactFragment(ARTIFACT);
    if (fragment === null) throw new Error("expected a materialized fragment");
    expect(fragment.doc).not.toBeNull();
    // The bytes really crossed - an empty fragment would satisfy a null check.
    // `toJSON()` rather than `toString()`: a `Y.XmlFragment` has no meaningful
    // default stringification, so the latter asserts against "[object Object]".
    expect(fragment.toJSON()).toContain("hello");
  });

  it("does not re-subscribe to deliver the body: the ORIGINAL subscription is the one that seeds it", async () => {
    // The property that separates this design from a reconnect: the retry is a
    // second `body/materialize`, not a second `artifact.subscribe`. A fix that
    // re-opened the lane would also pass the test above while paying a round
    // trip per body and re-seeding from scratch.
    const rig = rigUnderTest();
    await rig.open();
    await rig.seed();

    expect(rig.subscribeCount()).toBe(1);
    expect(rig.subscriptionIsOpen()).toBe(true);
  });
});
