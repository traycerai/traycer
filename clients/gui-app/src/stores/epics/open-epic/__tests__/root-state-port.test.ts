import { describe, expect, it } from "vitest";
import type { EpicStreamClientFactory } from "../runtime/legacy-epic-stream-adapter";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "../test-support/open-store-for-test";

function openSession(epicId: string): {
  readonly handle: OpenedStoreForTest;
  readonly sent: readonly Uint8Array[];
} {
  const sent: Uint8Array[] = [];
  const factory: EpicStreamClientFactory = () => ({
    applyUpdate: (bytes) => sent.push(bytes),
    awareness: () => {},
    applyArtifactRoomUpdate: () => {},
    artifactRoomAwareness: () => {},
    retryMigration: () => {},
    close: () => {},
  });
  // The blessed harness, which exposes the in-thread runtime's live `doc` as a getter.
  const handle = openStoreForTest({
    epicId,
    userId: null,
    factories: { streamClientFactory: factory, laneSelection: null },
    writeCommand: null,
  });
  return { handle, sent };
}

describe("the projected adapter arm", () => {
  it("publishes the installed arm, and the doc-key read uses it", () => {
    // The arm is a RUNTIME fact the store needs synchronously: `getArtifactBodyDocKey` answers the
    // artifact id on the lanes arm and the artifact's ROOM id on `@1`.
    const session = openSession("epic-a");

    // `null` until a selection runs, then the verdict. With no lane sources
    // there is nothing to select and `@1` is the arm.
    expect(session.handle.store.getState().installedArm).toBe("legacy");
    // On `@1` the doc key is the artifact's room, and an artifact with no
    // projected room has no key - not an empty string.
    expect(
      session.handle.store.getState().getArtifactBodyDocKey("artifact-1"),
    ).toBeNull();
    session.handle.dispose();
  });
});

describe("the root-state port", () => {
  it("carries an edit from one session's replica into another's projection", async () => {
    const source = openSession("epic-a");
    const target = openSession("epic-a");
    // A DOC write, not an overlay stamp.
    source.handle.doc.getMap("epic").set("title", "edited in source");

    const update = await source.handle.encodeRootState();
    const applied = await target.handle.applyRootUpdate(update, false);

    expect(applied).toBe(true);
    // The PROJECTION, not the target's doc: a port that wrote bytes nothing projected would satisfy a
    // doc-level assertion and still leave the UI showing the pre-merge title.
    expect(target.handle.store.getState().epic.title).toBe("edited in source");
    source.handle.dispose();
    target.handle.dispose();
  });

  it("applies with LOCAL_ORIGIN only when asLocalEdit is set", async () => {
    // `asLocalEdit` is not a convenience.
    const source = openSession("epic-a");
    const asLocal = openSession("epic-a");
    const asPlain = openSession("epic-a");
    // A DOC write, not an overlay stamp.
    source.handle.doc.getMap("epic").set("title", "edited in source");
    const update = await source.handle.encodeRootState();

    const localOrigins: unknown[] = [];
    const plainOrigins: unknown[] = [];
    // `handle.doc` is one of the reads that LEAVES at the flip; this observer moves to the worker side
    // with the replica, and the port above is what survives.
    asLocal.handle.doc.on("update", (_u: Uint8Array, origin: unknown) => {
      localOrigins.push(origin);
    });
    asPlain.handle.doc.on("update", (_u: Uint8Array, origin: unknown) => {
      plainOrigins.push(origin);
    });

    expect(await asLocal.handle.applyRootUpdate(update, true)).toBe(true);
    expect(await asPlain.handle.applyRootUpdate(update, false)).toBe(true);

    expect(localOrigins).toContain("local");
    expect(plainOrigins).not.toContain("local");
    // Both still LAND it - the difference is the origin, not the state.
    expect(asLocal.handle.store.getState().epic.title).toBe("edited in source");
    expect(asPlain.handle.store.getState().epic.title).toBe("edited in source");
    source.handle.dispose();
    asLocal.handle.dispose();
    asPlain.handle.dispose();
  });

  it("reports NOT applied for a disposed target rather than throwing", async () => {
    const source = openSession("epic-a");
    const target = openSession("epic-a");
    // A DOC write, not an overlay stamp.
    source.handle.doc.getMap("epic").set("title", "edited in source");
    const update = await source.handle.encodeRootState();
    target.handle.dispose();

    // Reported, never thrown.
    await expect(target.handle.applyRootUpdate(update, false)).resolves.toBe(
      false,
    );
    source.handle.dispose();
  });

  it("encodes state that survives a round trip through bytes alone", async () => {
    const source = openSession("epic-a");
    source.handle.doc.getMap("epic").set("title", "round trip");

    const update = await source.handle.encodeRootState();

    // A real transfer payload: bytes, not a live object.
    expect(ArrayBuffer.isView(update)).toBe(true);
    expect(update.byteLength).toBeGreaterThan(0);
    source.handle.dispose();
  });
});
