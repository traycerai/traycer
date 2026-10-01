/**
 * P2 regression, at the level the defect actually lives: two `@1` artifacts
 * sharing ONE room, where the artifact that first materialized it leaves the
 * room before the room comes back.
 *
 * ## The defect this pins
 *
 * `artifact-body-lease-bridge.ts`'s resident `BodyEntry.artifactId` is
 * whichever artifact's `acquire` first materialized the doc key - on `@1`
 * that is a fact about WHO ASKED FIRST, not about who still names the room.
 * `forget` (a room leaving `ready`) carries that same artifact id into the
 * `awaiting` record it creates, and before this fix `retryAwaitingBodies`
 * always re-asked with it. Two artifacts naming the same room, with the
 * FIRST one deleted while the room is down, is exactly the case where that
 * id no longer resolves to anything: the retry re-materializes with a
 * deleted artifact, gets nothing back, and reports the disagreement forever
 * (`reportAwaitingStalled`) while the SURVIVING artifact - which still names
 * the room and whose lease is still held - sits on a `ready` availability
 * with a `null` fragment. The fix lets the caller name a DIFFERENT artifact
 * per retry (`readyArtifactFor`), and `store.ts` answers with any artifact
 * the projection still files under that room when the preferred one no
 * longer does.
 *
 * ## Why this harness rather than the bridge-level pin alone
 *
 * The bridge-level pin (`artifact-body-lease-bridge.test.ts`) proves the
 * bridge asks with whatever the caller names. It cannot prove the CALLER -
 * `store.ts`'s `readyBodyArtifactsByDocKey` / `retryBodiesWhoseRoomBecameReady`
 * - actually computes "a1 no longer names room-1, a2 still does" correctly
 * from a real root-doc delete. This suite drives that: a real root Y.Doc
 * naming two artifacts under one room, a real delete delta removing one of
 * them, and the real availability/records projections in between.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/runtime/legacy-epic-stream-adapter";
import { encodeDocStateVectorBase64 } from "@/stores/epics/open-epic/runtime/dirty-watermark";
import { artifactBodyFragmentName } from "@traycer/protocol/persistence/epic/artifacts";

const ROOM = "artifact-room-0";
const ARTIFACT_A = "art-a";
const ARTIFACT_B = "art-b";

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
    hostStateVectorBase64: encodeDocStateVectorBase64(new Y.Doc()),
  };
}

function artifactEntry(id: string): Y.Map<unknown> {
  const entry = new Y.Map<unknown>();
  entry.set("id", id);
  entry.set("kind", "spec");
  entry.set("title", `Spec ${id}`);
  entry.set("parentId", null);
  entry.set("createdAt", 0);
  entry.set("updatedAt", 0);
  entry.set("artifactRoomId", ROOM);
  return entry;
}

interface SharedRoomRig {
  readonly handle: OpenedStoreForTest;
  readonly donorArtifacts: Y.Map<unknown>;
  open(): void;
  /**
   * The room reports ready and hands over a fresh Y.Doc snapshot carrying
   * BOTH artifacts' body fragments, in their own qualified names within the
   * one shared room doc - the real `@1` shape, not a bare "body" fragment.
   */
  materializeRoom(contentA: string, contentB: string): void;
  /** The room leaves ready - the availability transition `forget` reacts to. */
  dropRoom(): void;
  /** A root-doc DELTA removing one artifact's record entirely. */
  deleteArtifact(artifactId: string): void;
}

function createSharedRoomRig(): SharedRoomRig {
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
    epicId: "epic-legacy-shared-room-recovery",
    userId: null,
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

  // The SAME donor doc for the whole rig's life: a delete has to be a DELTA
  // against what main already installed, not a second independent document.
  const donor = new Y.Doc();
  const epicMap = donor.getMap<unknown>("epic");
  const donorArtifacts = new Y.Map<unknown>();
  epicMap.set("artifacts", donorArtifacts);
  donorArtifacts.set(ARTIFACT_A, artifactEntry(ARTIFACT_A));
  donorArtifacts.set(ARTIFACT_B, artifactEntry(ARTIFACT_B));

  return {
    handle,
    donorArtifacts,
    open(): void {
      live().onConnectionStatus("open", null, false);
      live().onSnapshot(buildMeta(), Y.encodeStateAsUpdate(donor));
    },
    materializeRoom(contentA: string, contentB: string): void {
      const seed = new Y.Doc();
      seed
        .getXmlFragment(artifactBodyFragmentName(ARTIFACT_A))
        .insert(0, [new Y.XmlText(contentA)]);
      seed
        .getXmlFragment(artifactBodyFragmentName(ARTIFACT_B))
        .insert(0, [new Y.XmlText(contentB)]);
      live().onArtifactRoomState(ROOM, "ready");
      live().onArtifactRoomSnapshot(
        ROOM,
        Y.encodeStateAsUpdate(seed),
        encodeDocStateVectorBase64(seed),
      );
    },
    dropRoom(): void {
      live().onArtifactRoomState(ROOM, "retrying");
    },
    deleteArtifact(artifactId: string): void {
      const before = Y.encodeStateVector(donor);
      donorArtifacts.delete(artifactId);
      live().onUpdate(Y.encodeStateAsUpdate(donor, before));
    },
  };
}

describe("two @1 artifacts sharing one room, the first deleted while the room is down", () => {
  const opened: OpenedStoreForTest[] = [];

  afterEach(() => {
    for (const handle of opened.splice(0)) handle.dispose();
  });

  function rigUnderTest(): SharedRoomRig {
    const rig = createSharedRoomRig();
    opened.push(rig.handle);
    rig.open();
    return rig;
  }

  it("B's fragment is non-null after the room recovers, even though A (the installer) is gone", async () => {
    const rig = rigUnderTest();
    const state = rig.handle.store.getState();

    // Two drains throughout, for the same reason every other suite in this
    // directory names theirs: the lease bridge's `body/materialize` round
    // trip is a real async hop even over the "sync" fake pipe, and a
    // materialize a projection triggers is queued behind the drain that
    // caused it.
    async function settle(): Promise<void> {
      await rig.handle.flush();
      await rig.handle.flush();
    }

    // A materializes the room first - the bridge's resident entry is filed
    // under A's artifact id, exactly the `@1` shape the fix's doc comments
    // describe.
    const releaseA = state.acquireArtifactBodyLease(ARTIFACT_A);
    const releaseB = state.acquireArtifactBodyLease(ARTIFACT_B);
    await settle();
    rig.materializeRoom("hello-a", "hello-b");
    await settle();

    const fragmentA = rig.handle.store
      .getState()
      .getArtifactFragment(ARTIFACT_A);
    const fragmentB = rig.handle.store
      .getState()
      .getArtifactFragment(ARTIFACT_B);
    if (fragmentA === null || fragmentB === null) {
      throw new Error("expected both artifacts to see the shared room's body");
    }
    expect(fragmentA.toJSON()).toContain("hello-a");
    expect(fragmentB.toJSON()).toContain("hello-b");

    // A leaves: its lease releases AND its root record is deleted outright -
    // the room now has exactly one artifact naming it, and it is not the one
    // that installed the resident entry.
    releaseA();
    rig.deleteArtifact(ARTIFACT_A);
    await settle();

    // The room drops out from under the still-held B lease, then comes back
    // with fresh content.
    rig.dropRoom();
    await settle();
    expect(
      rig.handle.store.getState().getArtifactFragment(ARTIFACT_B),
    ).toBeNull();

    rig.materializeRoom("stale-a-should-not-matter", "recovered");
    await settle();

    // THE REDDENING ASSERTION pre-fix: the retry always re-asked with A's
    // (now deleted) artifact id, got nothing back, and reported a stalled
    // disagreement forever - B's availability read `ready` while its
    // fragment stayed `null`.
    const recovered = rig.handle.store
      .getState()
      .getArtifactFragment(ARTIFACT_B);
    if (recovered === null) {
      throw new Error(
        "expected B's fragment to be resident again after the room recovered",
      );
    }
    expect(recovered.toJSON()).toContain("recovered");
    expect(
      rig.handle.store.getState().getArtifactBodyAvailability(ARTIFACT_B),
    ).toBe("ready");

    releaseB();
  });
});
