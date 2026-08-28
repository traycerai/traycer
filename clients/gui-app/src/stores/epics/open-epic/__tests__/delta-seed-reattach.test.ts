import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { EpicSubscribeClientSeedOffer } from "@traycer/protocol/host/epic/subscribe";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
} from "@/stores/epics/open-epic/store";

/**
 * `epic.subscribe@1.3` delta-seeded reattach - gui-app store side.
 *
 * `doc` (the local replica) always merges via `Y.applyUpdate`, so it is safe
 * either way a snapshot is routed. `hostCoverageDoc` is the dangerous one: a
 * FULL snapshot rebuilds it from scratch (safe - full snapshots are
 * self-sufficient), but a DELTA deliberately omits everything the host knows
 * this client already had, so routing a delta to the rebuild arm would
 * silently collapse coverage down to the handful of bytes that changed. This
 * suite is the seam `applyRootSeedToHostCoverage` protects.
 */

interface FakeStreamHandle {
  readonly callbacks: EpicStreamCallbacks;
  readonly seedOfferProvider: () => EpicSubscribeClientSeedOffer | null;
}

function fakeFactory(): {
  factory: EpicStreamClientFactory;
  handle: () => FakeStreamHandle;
} {
  let current: FakeStreamHandle | null = null;
  const factory: EpicStreamClientFactory = (
    _epicId,
    callbacks,
    seedOfferProvider,
  ) => {
    current = { callbacks, seedOfferProvider };
    return {
      applyUpdate: () => {},
      awareness: () => {},
      applyArtifactRoomUpdate: () => {},
      artifactRoomAwareness: () => {},
      retryMigration: () => {},
      close: () => {},
    };
  };
  return {
    factory,
    handle: () => {
      if (current === null) throw new Error("factory not invoked");
      return current;
    },
  };
}

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function stateVectorBase64(doc: Y.Doc): string {
  return encodeBase64(Y.encodeStateVector(doc));
}

function decodeBase64(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function buildMeta(options: {
  readonly role: "owner" | "editor" | "viewer";
  readonly hostDoc: Y.Doc;
  readonly roomId?: string;
  readonly seededFromOffer?: true;
}): SnapshotMetaEpic {
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
    permissionRole: options.role,
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: stateVectorBase64(options.hostDoc),
    roomId: options.roomId,
    seededFromOffer: options.seededFromOffer,
  };
}

/** `[0, 0]` is Yjs's encoding for "no update needed" - full convergence. */
const EMPTY_UPDATE_BYTES = [0, 0];

describe("epic.subscribe@1.3 delta-seeded reattach - hostCoverageDoc merge safety", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("merges a delta into hostCoverageDoc instead of rebuilding - coverage keeps content from BOTH cycles", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-a",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    // Cycle 1: a full snapshot seeding content X.
    const originDoc = new Y.Doc();
    originDoc.getMap("epic").set("x", "content-x");
    const fullSnapshotBytes = Y.encodeStateAsUpdate(originDoc);
    handle().callbacks.onSnapshot(
      buildMeta({ role: "editor", hostDoc: originDoc, roomId: "room-1" }),
      fullSnapshotBytes,
    );

    const offerAfterFull = handle().seedOfferProvider();
    expect(offerAfterFull).not.toBeNull();
    if (offerAfterFull === null) throw new Error("expected an offer");

    // Cycle 2: the host adds content Y and answers a reattach with a DELTA
    // computed against the offer above - exactly what the real resolver does
    // (`encodeRootSeed` in `epic-stream-resolver.ts`).
    originDoc.getMap("epic").set("y", "content-y");
    const deltaBytes = Y.encodeStateAsUpdate(
      originDoc,
      decodeBase64(offerAfterFull.stateVectorBase64),
    );
    handle().callbacks.onSnapshot(
      buildMeta({
        role: "editor",
        hostDoc: originDoc,
        roomId: "room-1",
        seededFromOffer: true,
      }),
      deltaBytes,
    );

    // Prove coverage holds BOTH X and Y: diffing the true origin doc against
    // the NEW offer's state vector must be the empty update. If the delta had
    // instead been routed to the rebuild arm, coverage would only reflect Y
    // (or nothing X-related would have integrated at all, since the delta's
    // clock range for `originDoc`'s clientID has no predecessor in a fresh
    // doc), and this diff would come back non-empty.
    const offerAfterDelta = handle().seedOfferProvider();
    expect(offerAfterDelta).not.toBeNull();
    if (offerAfterDelta === null) throw new Error("expected an offer");
    const remainder = Y.encodeStateAsUpdate(
      originDoc,
      decodeBase64(offerAfterDelta.stateVectorBase64),
    );
    expect(Array.from(remainder)).toEqual(EMPTY_UPDATE_BYTES);

    opened.dispose();
  });

  it("the seed offer is null before any snapshot has landed (cold open sends no offer)", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-a",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    expect(handle().seedOfferProvider()).toBeNull();

    opened.dispose();
  });

  it("after a full snapshot carrying a roomId, the offer is non-null and carries that exact roomId", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-a",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    const hostDoc = new Y.Doc();
    hostDoc.getMap("epic").set("title", "hello");
    handle().callbacks.onSnapshot(
      buildMeta({ role: "editor", hostDoc, roomId: "room-xyz" }),
      Y.encodeStateAsUpdate(hostDoc),
    );

    const offer = handle().seedOfferProvider();
    expect(offer).not.toBeNull();
    expect(offer?.roomId).toBe("room-xyz");

    opened.dispose();
  });

  it("a snapshot whose meta.roomId is absent (a pre-@1.2 host) leaves the offer null", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-a",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    const hostDoc = new Y.Doc();
    hostDoc.getMap("epic").set("title", "hello");
    handle().callbacks.onSnapshot(
      buildMeta({ role: "editor", hostDoc }),
      Y.encodeStateAsUpdate(hostDoc),
    );

    expect(handle().seedOfferProvider()).toBeNull();

    opened.dispose();
  });

  it("after a replica reset (requestFreshSnapshot), the offer returns to null", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-a",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    const hostDoc = new Y.Doc();
    hostDoc.getMap("epic").set("title", "hello");
    handle().callbacks.onSnapshot(
      buildMeta({ role: "editor", hostDoc, roomId: "room-xyz" }),
      Y.encodeStateAsUpdate(hostDoc),
    );
    expect(handle().seedOfferProvider()).not.toBeNull();

    opened.requestFreshSnapshot();

    expect(handle().seedOfferProvider()).toBeNull();

    opened.dispose();
  });
});

describe("epic.subscribe@1.3 delta-seeded reattach - hostCoverageDoc doc-identity generation guard", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("18) a delta whose basis doc was replaced mid-flight (permission-loss race) is NOT merged, and the offer goes null", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-a",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    const originDoc = new Y.Doc();
    originDoc.getMap("epic").set("x", "content-x");
    handle().callbacks.onSnapshot(
      buildMeta({ role: "editor", hostDoc: originDoc, roomId: "room-1" }),
      Y.encodeStateAsUpdate(originDoc),
    );

    // Read the offer - this is the request the eventual delta will race
    // against.
    const offer = handle().seedOfferProvider();
    expect(offer).not.toBeNull();
    if (offer === null) throw new Error("expected an offer");

    // The reply's round trip loses: permission is revoked before the delta
    // lands, which replaces (not merges into) hostCoverageDoc.
    handle().callbacks.onPermissionChanged(null);

    // The delta arrives late, computed against the NOW-DISCARDED doc.
    originDoc.getMap("epic").set("y", "content-y");
    const staleDeltaBytes = Y.encodeStateAsUpdate(
      originDoc,
      decodeBase64(offer.stateVectorBase64),
    );
    handle().callbacks.onSnapshot(
      buildMeta({
        role: "editor",
        hostDoc: originDoc,
        roomId: "room-1",
        seededFromOffer: true,
      }),
      staleDeltaBytes,
    );

    // If the guard had not fired, this merge would have set a roomId (and
    // corrupted the empty post-revocation doc). No offer means no room id
    // was taken - the merge was skipped.
    expect(handle().seedOfferProvider()).toBeNull();

    opened.dispose();
  });

  it("19) the control for 18 - no intervening replacement, the delta DOES merge", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-a",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    const originDoc = new Y.Doc();
    originDoc.getMap("epic").set("x", "content-x");
    handle().callbacks.onSnapshot(
      buildMeta({ role: "editor", hostDoc: originDoc, roomId: "room-1" }),
      Y.encodeStateAsUpdate(originDoc),
    );

    const offer = handle().seedOfferProvider();
    expect(offer).not.toBeNull();
    if (offer === null) throw new Error("expected an offer");

    originDoc.getMap("epic").set("y", "content-y");
    const deltaBytes = Y.encodeStateAsUpdate(
      originDoc,
      decodeBase64(offer.stateVectorBase64),
    );
    handle().callbacks.onSnapshot(
      buildMeta({
        role: "editor",
        hostDoc: originDoc,
        roomId: "room-1",
        seededFromOffer: true,
      }),
      deltaBytes,
    );

    // Merge succeeded: coverage now reflects BOTH x and y, proven the same
    // way as the base safety test - diffing the true origin doc against the
    // new offer's vector comes back empty.
    const offerAfterDelta = handle().seedOfferProvider();
    expect(offerAfterDelta).not.toBeNull();
    if (offerAfterDelta === null) throw new Error("expected an offer");
    const remainder = Y.encodeStateAsUpdate(
      originDoc,
      decodeBase64(offerAfterDelta.stateVectorBase64),
    );
    expect(Array.from(remainder)).toEqual(EMPTY_UPDATE_BYTES);

    opened.dispose();
  });

  it("20) coverage advancing via an ordinary update while an offer is outstanding is NOT treated as staleness - the later delta still merges", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-a",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    const originDoc = new Y.Doc();
    originDoc.getMap("epic").set("x", "content-x");
    handle().callbacks.onSnapshot(
      buildMeta({ role: "editor", hostDoc: originDoc, roomId: "room-1" }),
      Y.encodeStateAsUpdate(originDoc),
    );

    const offer = handle().seedOfferProvider();
    expect(offer).not.toBeNull();
    if (offer === null) throw new Error("expected an offer");
    const svAfterFullSnapshot = decodeBase64(offer.stateVectorBase64);

    // Ordinary forward movement: an `onUpdate` frame merges into coverage
    // via `Y.applyUpdate` directly - it must NOT bump the generation, since
    // this is the same doc, just further along.
    originDoc.getMap("epic").set("y", "content-y");
    const ordinaryUpdateBytes = Y.encodeStateAsUpdate(
      originDoc,
      svAfterFullSnapshot,
    );
    handle().callbacks.onUpdate(ordinaryUpdateBytes);

    // A late delta computed against the ORIGINAL offer (predating y) still
    // arrives and must still merge - it is a superset of what coverage
    // needs, and coverage moving forward under an in-flight offer is the
    // harmless direction the guard deliberately does not reject.
    originDoc.getMap("epic").set("z", "content-z");
    const deltaBytes = Y.encodeStateAsUpdate(originDoc, svAfterFullSnapshot);
    handle().callbacks.onSnapshot(
      buildMeta({
        role: "editor",
        hostDoc: originDoc,
        roomId: "room-1",
        seededFromOffer: true,
      }),
      deltaBytes,
    );

    // Coverage must now hold x, y AND z - proof the delta was not silently
    // dropped by a guard that (wrongly) treated forward movement as
    // staleness.
    const offerAfterDelta = handle().seedOfferProvider();
    expect(offerAfterDelta).not.toBeNull();
    if (offerAfterDelta === null) throw new Error("expected an offer");
    const remainder = Y.encodeStateAsUpdate(
      originDoc,
      decodeBase64(offerAfterDelta.stateVectorBase64),
    );
    expect(Array.from(remainder)).toEqual(EMPTY_UPDATE_BYTES);

    opened.dispose();
  });
});
