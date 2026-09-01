/**
 * The root-state PORT, driven through two real sessions.
 *
 * `encodeRootState` / `applyRootUpdate` replace what two merge sites do today
 * by reaching for `handle.doc` directly. They are introduced while the replica
 * is still in-process - "seams before relocation" - so what these pins assert
 * is the port's CONTRACT, and the flip changes only which side of the bridge
 * the implementation sits on.
 *
 * Two real stores, no stub in the middle: the transfer is a real
 * `Y.encodeStateAsUpdate` into a real `Y.applyUpdate`, and the assertion is
 * that the receiving session's PROJECTION carries the source's edit. Asserting
 * on the target's doc would pass just as well against a port that wrote bytes
 * nothing ever projected.
 */
import { describe, expect, it } from "vitest";
import type { EpicStreamClientFactory } from "../runtime/legacy-epic-stream-adapter";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "../test-support/open-store-for-test";

/**
 * A session plus the updates its stream client was asked to SEND.
 *
 * Recording the outbound sends is what makes the `asLocalEdit` distinction
 * observable at all. Both merges land the same state in the receiving replica,
 * so an assertion on the projected title passes whichever origin was used -
 * which is exactly how the first version of these pins stayed green with the
 * flag ablated. What the origin decides is whether the union is RE-SENT.
 */
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
  // The blessed harness, which exposes the in-thread runtime's live `doc` as a
  // getter. That is what keeps the origin observer below possible: a
  // PRODUCTION handle has no doc - the replica is on the worker thread - so a
  // suite that needs one has to be the side that built it.
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
    // The arm is a RUNTIME fact the store needs synchronously:
    // `getArtifactBodyDocKey` answers the artifact id on the lanes arm and the
    // artifact's ROOM id on `@1`. It is published through `delivery.publish`,
    // which takes a `Partial<EpicRuntimeProjection>` and so reaches any member
    // - the per-replica sinks are typed to their own sub-projection, so the
    // runtime could not have published a selection fact without putting it on
    // the records slice.
    // `createOpenEpicStore` starts the runtime itself - there is no `start` on
    // the store's own surface, which is why this reads the arm directly.
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
    // A DOC write, not an overlay stamp. This suite transfers root STATE, and
    // `beginEpicTitleMutation` records an optimistic overlay that the doc does
    // not carry - so `encodeRootState` would ship bytes without the edit and
    // the assertion would be about nothing. `setEpicTitle` (which this
    // replaced during the cohort migration) was a doc write; the port needs
    // the same.
    source.handle.doc.getMap("epic").set("title", "edited in source");

    const update = await source.handle.encodeRootState();
    const applied = await target.handle.applyRootUpdate(update, false);

    expect(applied).toBe(true);
    // The PROJECTION, not the target's doc: a port that wrote bytes nothing
    // projected would satisfy a doc-level assertion and still leave the UI
    // showing the pre-merge title.
    expect(target.handle.store.getState().epic.title).toBe("edited in source");
    source.handle.dispose();
    target.handle.dispose();
  });

  it("applies with LOCAL_ORIGIN only when asLocalEdit is set", async () => {
    // `asLocalEdit` is not a convenience. The provider's replacement merge
    // applies with `LOCAL_ORIGIN` so the union routes through the replacement's
    // normal local-update path and unacknowledged edits survive for recovery;
    // the registry's retention merge applies with no origin, because a retained
    // buffer is not re-sending anything.
    //
    // Observed at the DOC's update origin, which is what the flag sets and what
    // every downstream decision reads. Two weaker observables were tried first
    // and both were wrong: asserting the landed title passes with the flag
    // ignored (ablation proved it), and asserting the outbound re-send is
    // unreachable here because an unstarted session has no transport to send
    // on. This one is direct.
    const source = openSession("epic-a");
    const asLocal = openSession("epic-a");
    const asPlain = openSession("epic-a");
    // A DOC write, not an overlay stamp. This suite transfers root STATE, and
    // `beginEpicTitleMutation` records an optimistic overlay that the doc does
    // not carry - so `encodeRootState` would ship bytes without the edit and
    // the assertion would be about nothing. `setEpicTitle` (which this
    // replaced during the cohort migration) was a doc write; the port needs
    // the same.
    source.handle.doc.getMap("epic").set("title", "edited in source");
    const update = await source.handle.encodeRootState();

    const localOrigins: unknown[] = [];
    const plainOrigins: unknown[] = [];
    // `handle.doc` is one of the reads that LEAVES at the flip; this observer
    // moves to the worker side with the replica, and the port above is what
    // survives.
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
    // A DOC write, not an overlay stamp. This suite transfers root STATE, and
    // `beginEpicTitleMutation` records an optimistic overlay that the doc does
    // not carry - so `encodeRootState` would ship bytes without the edit and
    // the assertion would be about nothing. `setEpicTitle` (which this
    // replaced during the cohort migration) was a doc write; the port needs
    // the same.
    source.handle.doc.getMap("epic").set("title", "edited in source");
    const update = await source.handle.encodeRootState();
    target.handle.dispose();

    // Reported, never thrown. Both merge sites are synchronous lifecycle
    // callbacks with no way to answer a throw, and the boolean is what decides
    // whether the source's edits count as transferred - a rejected apply means
    // they still live only in the source.
    await expect(target.handle.applyRootUpdate(update, false)).resolves.toBe(
      false,
    );
    source.handle.dispose();
  });

  it("encodes state that survives a round trip through bytes alone", async () => {
    const source = openSession("epic-a");
    source.handle.doc.getMap("epic").set("title", "round trip");

    const update = await source.handle.encodeRootState();

    // A real transfer payload: bytes, not a live object. This is what the flip
    // will put on the wire, and a port that answered a `Y.Doc` reference would
    // pass every assertion above while being unshippable.
    // `ArrayBuffer.isView`, not `toBeInstanceOf(Uint8Array)`. The bytes cross
    // the bridge through `structuredClone`, which mints them in the pipe's
    // realm - so they ARE a `Uint8Array`, just not the one this module's
    // global names, and an identity check fails on an environment detail
    // rather than on the claim. The claim is "these are bytes, not a live
    // object", and `isView` states exactly that in a realm-independent way.
    expect(ArrayBuffer.isView(update)).toBe(true);
    expect(update.byteLength).toBeGreaterThan(0);
    source.handle.dispose();
  });
});
