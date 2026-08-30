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

import {
  createMainThreadBodyDocStore,
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

function textOf(store: MainThreadBodyDocStore): string {
  const fragment = store.fragment(DOC_KEY, ARTIFACT);
  return fragment === null ? "<not resident>" : fragment.toJSON();
}

describe("install", () => {
  it("makes the body resident and its fragment readable", () => {
    const store = createMainThreadBodyDocStore();
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
    const store = createMainThreadBodyDocStore();
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
    const store = createMainThreadBodyDocStore();
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
    const store = createMainThreadBodyDocStore();
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
    const store = createMainThreadBodyDocStore();

    expect(store.encode("absent")).toEqual(new Uint8Array());
  });
});

describe("drop", () => {
  it("makes the body non-resident and its fragment unreachable", () => {
    const store = createMainThreadBodyDocStore();
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
    const store = createMainThreadBodyDocStore();

    expect(() => store.drop("absent")).not.toThrow();
  });
});

describe("awareness", () => {
  it("is per body, and a different instance per doc key", () => {
    // Two bodies must not share a presence channel: a caret bound to one
    // fragment would otherwise be routed through the other's topology.
    const store = createMainThreadBodyDocStore();
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
    const store = createMainThreadBodyDocStore();
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
