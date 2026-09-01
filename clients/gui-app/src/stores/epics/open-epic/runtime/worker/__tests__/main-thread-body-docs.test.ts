/**
 * The main-side body docs — owed #3's hot half.
 *
 * The pin that matters is the seed rule, and it is the one with a data-loss
 * failure mode: a `"full"` snapshot whose guid DIFFERS must REPLACE the
 * document, never be applied on top of it. Merging two unrelated Yjs histories
 * produces a document containing both, and no user action undoes that - it is
 * unrecoverable rather than lossy, which is a different and worse category
 * than dropping an edit.
 *
 * Real `Y.Doc`s throughout. A fake would let the merge-versus-replace
 * distinction be asserted as a call pattern rather than as the document
 * content it actually is, and the content is the whole claim.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { artifactBodyFragmentName } from "@traycer/protocol/persistence/epic/artifacts";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";

import {
  createMainThreadBodyDocStore,
  type MainThreadBodyDocSinks,
  type MainThreadBodyDocStore,
} from "../main-thread-body-docs";

const ARTIFACT = "artifact-1";
const DOC_KEY = "room-1";

/** A document with one paragraph of `text`, encoded as a full update. */
function snapshotWith(text: string): { update: Uint8Array; guid: string } {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment(artifactBodyFragmentName(ARTIFACT));
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText(text)]);
  fragment.insert(0, [paragraph]);
  const update = Y.encodeStateAsUpdate(doc);
  const guid = doc.guid;
  doc.destroy();
  return { update, guid };
}

/**
 * ONE construction site, so the next member added to this factory is one
 * compile error rather than eight. Every sink is a no-op here; a suite that
 * cares about one spreads this and overrides that one.
 */
const NOOP_SINKS: MainThreadBodyDocSinks = {
  onResidencyChange: () => {},
  onLocalDocUpdate: () => {},
  onLocalAwareness: () => {},
};

function createStore(): MainThreadBodyDocStore {
  return createMainThreadBodyDocStore(NOOP_SINKS);
}

function textOf(store: MainThreadBodyDocStore): string {
  const fragment = store.fragment(DOC_KEY, ARTIFACT);
  return fragment === null ? "<not resident>" : fragment.toJSON();
}

describe("install", () => {
  it("makes the body resident and its fragment readable", () => {
    const store = createStore();
    const seed = snapshotWith("hello");

    store.install({
      docKey: DOC_KEY,
      update: seed.update,
      docGuid: seed.guid,
      seedMode: "full",
      hostStateVector: null,
    });

    expect(store.has(DOC_KEY)).toBe(true);
    expect(textOf(store)).toContain("hello");
  });

  it("REPLACES rather than merges when the guid changes", () => {
    // The data-loss pin. Two unrelated histories, same doc key - which is
    // exactly a body deleted and recreated while a lease was held.
    const store = createStore();
    const first = snapshotWith("original");
    const second = snapshotWith("recreated");
    expect(first.guid).not.toBe(second.guid);

    store.install({
      docKey: DOC_KEY,
      update: first.update,
      docGuid: first.guid,
      seedMode: "full",
      hostStateVector: null,
    });
    store.install({
      docKey: DOC_KEY,
      update: second.update,
      docGuid: second.guid,
      seedMode: "full",
      hostStateVector: null,
    });

    const text = textOf(store);
    expect(text).toContain("recreated");
    // The whole point: the old content is GONE, not sitting beside the new.
    // A merge leaves both paragraphs and reads as a document the user never
    // authored.
    expect(text).not.toContain("original");
  });

  it("merges when the guid is the same, and does so idempotently", () => {
    // The other direction, so the replace pin cannot be satisfied by a store
    // that throws everything away on every install.
    const store = createStore();
    const seed = snapshotWith("hello");

    store.install({
      docKey: DOC_KEY,
      update: seed.update,
      docGuid: seed.guid,
      seedMode: "full",
      hostStateVector: null,
    });
    const afterFirst = textOf(store);

    // A local edit, then the SAME snapshot re-delivered. The edit must survive:
    // same lineage means the snapshot is an ancestor, not a replacement.
    const fragment = store.fragment(DOC_KEY, ARTIFACT);
    if (fragment === null) throw new Error("body not resident");
    const added = new Y.XmlElement("paragraph");
    added.insert(0, [new Y.XmlText("local edit")]);
    fragment.insert(fragment.length, [added]);

    store.install({
      docKey: DOC_KEY,
      update: seed.update,
      docGuid: seed.guid,
      seedMode: "full",
      hostStateVector: null,
    });

    expect(afterFirst).toContain("hello");
    expect(textOf(store)).toContain("hello");
    expect(textOf(store)).toContain("local edit");
  });
});

describe("encode", () => {
  it("round-trips the live document, local edits included", () => {
    const store = createStore();
    const seed = snapshotWith("hello");
    store.install({
      docKey: DOC_KEY,
      update: seed.update,
      docGuid: seed.guid,
      seedMode: "full",
      hostStateVector: null,
    });
    const fragment = store.fragment(DOC_KEY, ARTIFACT);
    if (fragment === null) throw new Error("body not resident");
    const added = new Y.XmlElement("paragraph");
    added.insert(0, [new Y.XmlText("unsynced")]);
    fragment.insert(fragment.length, [added]);

    // What the demote posts. It has to carry the edit, because after an
    // accepted demote this doc is dropped and these bytes are the only copy.
    const encoded = store.encode(DOC_KEY);
    const rebuilt = new Y.Doc();
    Y.applyUpdate(rebuilt, encoded);

    expect(
      rebuilt.getXmlFragment(artifactBodyFragmentName(ARTIFACT)).toJSON(),
    ).toContain("unsynced");
    rebuilt.destroy();
  });

  it("answers empty bytes for a doc it does not hold, rather than throwing", () => {
    // The caller is the demote path and the lease bridge already refuses to
    // post for an entry it does not have; a throw here turns a benign race
    // into a failed teardown.
    const store = createStore();

    expect(store.encode("absent")).toEqual(new Uint8Array());
  });
});

describe("drop", () => {
  it("makes the body non-resident and its fragment unreachable", () => {
    const store = createStore();
    const seed = snapshotWith("hello");
    store.install({
      docKey: DOC_KEY,
      update: seed.update,
      docGuid: seed.guid,
      seedMode: "full",
      hostStateVector: null,
    });

    store.drop(DOC_KEY);

    expect(store.has(DOC_KEY)).toBe(false);
    expect(store.fragment(DOC_KEY, ARTIFACT)).toBeNull();
    expect(store.awareness(DOC_KEY)).toBeNull();
    expect(store.residentDocKeys()).toEqual([]);
  });

  it("is a no-op for a key it never held", () => {
    const store = createStore();

    expect(() => store.drop("absent")).not.toThrow();
  });
});

describe("awareness", () => {
  it("is per body, and a different instance per doc key", () => {
    // Two bodies must not share a presence channel: a caret bound to one
    // fragment would otherwise be routed through the other's topology.
    const store = createStore();
    const first = snapshotWith("one");
    const second = snapshotWith("two");
    store.install({
      docKey: "room-1",
      update: first.update,
      docGuid: first.guid,
      seedMode: "full",
      hostStateVector: null,
    });
    store.install({
      docKey: "room-2",
      update: second.update,
      docGuid: second.guid,
      seedMode: "full",
      hostStateVector: null,
    });

    const one = store.awareness("room-1");
    const two = store.awareness("room-2");
    expect(one).not.toBeNull();
    expect(two).not.toBeNull();
    expect(one).not.toBe(two);
  });
});

describe("residentDocKeys", () => {
  it("is the main-side answer to what used to be the tier's hot set", () => {
    const store = createStore();
    const seed = snapshotWith("hello");
    store.install({
      docKey: "room-1",
      update: seed.update,
      docGuid: seed.guid,
      seedMode: "full",
      hostStateVector: null,
    });

    expect(store.residentDocKeys()).toEqual(["room-1"]);

    store.dropAll();

    expect(store.residentDocKeys()).toEqual([]);
    expect(store.has("room-1")).toBe(false);
  });
});

describe("the residency signal", () => {
  it("fires when a body becomes resident and when it is dropped", () => {
    // The re-render signal. Without it a synchronous `getArtifactFragment`
    // read of an asynchronously-filled set is invisible to React: the editor
    // sees `null` at `ready` and never looks again.
    let fired = 0;
    const store = createMainThreadBodyDocStore({
      ...NOOP_SINKS,
      onResidencyChange: () => {
        fired += 1;
      },
    });
    const seed = snapshotWith("hello");

    store.install({
      docKey: DOC_KEY,
      update: seed.update,
      docGuid: seed.guid,
      seedMode: "full",
      hostStateVector: null,
    });
    expect(fired).toBe(1);

    store.drop(DOC_KEY);
    expect(fired).toBe(2);
  });

  it("does not fire for an update applied to a body already resident", () => {
    // The fragment REFERENCE is unchanged, and Yjs notifies its own observers
    // for the content. A bump here would re-render every editor on every
    // inbound delta for no reason.
    let fired = 0;
    const store = createMainThreadBodyDocStore({
      ...NOOP_SINKS,
      onResidencyChange: () => {
        fired += 1;
      },
    });
    const seed = snapshotWith("hello");
    const install = (): void => {
      store.install({
        docKey: DOC_KEY,
        update: seed.update,
        docGuid: seed.guid,
        seedMode: "full",
        hostStateVector: null,
      });
    };

    install();
    install();

    expect(fired).toBe(1);
  });
});

/**
 * The private origin's DOUBLE DUTY.
 *
 * One symbol, two jobs, and each is pinned separately because they fail
 * differently and a single test would let either half rot:
 *
 *  - the REMOTE applies (`install`'s same-lineage branch, `applyRemote`,
 *    `applyRemoteAwareness`) must not read as local, or a collaborator's edit
 *    is echoed straight back and two typing peers loop;
 *  - the initial SEED must not read as local, which is the half that looks
 *    unnecessary. Nothing breaks visibly when it is missing - Yjs merges the
 *    echo harmlessly - it just ships the entire document over the wire every
 *    time a body opens, which reads as a slow network rather than a bug.
 *
 * Each has a POSITIVE counterpart in the same block: a pin that only proves
 * "nothing was sent" passes just as well against a store that sends nothing
 * at all.
 */
describe("the local/remote origin split", () => {
  interface Captured {
    readonly docs: { docKey: string; update: Uint8Array }[];
    readonly presence: { docKey: string; clientId: number }[];
  }

  function createCapturingStore(): {
    store: MainThreadBodyDocStore;
    captured: Captured;
  } {
    const captured: Captured = { docs: [], presence: [] };
    const store = createMainThreadBodyDocStore({
      ...NOOP_SINKS,
      onLocalDocUpdate: (docKey, update) => {
        captured.docs.push({ docKey, update });
      },
      onLocalAwareness: (docKey, _frame, localClientId) => {
        captured.presence.push({ docKey, clientId: localClientId });
      },
    });
    return { store, captured };
  }

  function seed(store: MainThreadBodyDocStore): string {
    const snapshot = snapshotWith("hello");
    store.install({
      docKey: DOC_KEY,
      update: snapshot.update,
      docGuid: snapshot.guid,
      seedMode: "full",
      hostStateVector: null,
    });
    return snapshot.guid;
  }

  it("does not report the initial seed as a local edit", () => {
    const { store, captured } = createCapturingStore();
    seed(store);
    // The document has content - this is not vacuously empty.
    expect(textOf(store)).toContain("hello");
    expect(captured.docs).toHaveLength(0);
  });

  it("does not report a same-lineage install as a local edit", () => {
    const { store, captured } = createCapturingStore();
    const guid = seed(store);

    // A second install for the same lineage: an update, not a replacement.
    const follow = new Y.Doc();
    Y.applyUpdate(follow, Y.encodeStateAsUpdate(new Y.Doc()));
    store.install({
      docKey: DOC_KEY,
      update: Y.encodeStateAsUpdate(follow),
      docGuid: guid,
      seedMode: "full",
      hostStateVector: null,
    });
    follow.destroy();

    expect(captured.docs).toHaveLength(0);
  });

  it("does not report a remote update as a local edit", () => {
    const { store, captured } = createCapturingStore();
    seed(store);

    // A collaborator's edit, built against the SAME lineage so it merges
    // rather than being ignored as unrelated history.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(new Y.Doc()));
    const fragment = peer.getXmlFragment(artifactBodyFragmentName(ARTIFACT));
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("from-peer")]);
    fragment.insert(0, [paragraph]);
    store.applyRemote(DOC_KEY, Y.encodeStateAsUpdate(peer));
    peer.destroy();

    expect(captured.docs).toHaveLength(0);
  });

  it("DOES report an edit made through the live fragment", () => {
    // The positive half. Without it every assertion above passes against a
    // store whose outbound leg was never wired at all.
    const { store, captured } = createCapturingStore();
    seed(store);

    const fragment = store.fragment(DOC_KEY, ARTIFACT);
    expect(fragment).not.toBeNull();
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("typed")]);
    fragment?.insert(0, [paragraph]);

    expect(captured.docs).toHaveLength(1);
    expect(captured.docs[0]?.docKey).toBe(DOC_KEY);
  });

  it("does not report remote presence as local, but DOES report our own", () => {
    const { store, captured } = createCapturingStore();
    seed(store);

    const awareness = store.awareness(DOC_KEY);
    expect(awareness).not.toBeNull();

    // A peer's presence, arriving from the worker.
    const peerDoc = new Y.Doc();
    const peerAwareness = new Awareness(peerDoc);
    peerAwareness.setLocalState({ user: "peer" });
    store.applyRemoteAwareness(
      DOC_KEY,
      encodeAwarenessUpdate(peerAwareness, [peerAwareness.clientID]),
    );
    expect(captured.presence).toHaveLength(0);

    // Our own, set through the live instance the editor binds to.
    awareness?.setLocalState({ user: "me" });
    expect(captured.presence).toHaveLength(1);
    // Reported under the id of the Awareness that PRODUCED it - the tier
    // excludes exactly this id from its remote-peer pin, so a wrong one here
    // holds the room hot forever.
    expect(captured.presence[0]?.clientId).toBe(awareness?.clientID);

    peerAwareness.destroy();
    peerDoc.destroy();
  });

  it("emits no presence frame while tearing a body down", () => {
    // THE detach pin, and it is deliberately this one rather than a
    // "nothing arrives after the drop" probe.
    //
    // A post-drop probe cannot fail: `Y.Doc.destroy()` empties its own
    // observer map, so the doc handler is released whether or not this module
    // detaches it, and asserting on it would pass against a store that never
    // called `off` at all. That is a vacuous pin wearing the right words.
    //
    // `Awareness.destroy()` is different: it REMOVES this client's state,
    // which emits an update. A handler still attached at that moment reports
    // it as a local presence change - so the store announces a cursor
    // arriving, by way of one departing, for a body it has already released.
    // That is observable, so it is what gets pinned; ablate the
    // `awareness.off(...)` in `destroy` and this goes red.
    const { store, captured } = createCapturingStore();
    seed(store);

    const awareness = store.awareness(DOC_KEY);
    awareness?.setLocalState({ user: "me" });
    // The positive baseline: presence IS being reported before the drop, so
    // the assertion below is about the teardown and not about a dead channel.
    expect(captured.presence).toHaveLength(1);

    store.drop(DOC_KEY);

    expect(captured.presence).toHaveLength(1);
    expect(store.has(DOC_KEY)).toBe(false);
  });
});
