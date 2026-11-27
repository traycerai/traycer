import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  readArtifactIndexSelection,
  type ArtifactIndexSelection,
} from "../artifact-index-selection";

// The stored names, spelled out: the selection is a persisted format, so a
// renamed constant must fail here.
const EPOCH_KEY = "artifactIndexEpoch";
const V1_ROOTS = ["artifactIndexV1", "artifactDeletionsV1"] as const;

/** A document holding one legacy row and no epoch. */
function legacyDoc(): Y.Doc {
  const doc = new Y.Doc();
  const artifacts = new Y.Map<unknown>();
  artifacts.set("legacy", new Y.Map<unknown>());
  doc.getMap("epic").set("artifacts", artifacts);
  return doc;
}

function docWithEpoch(value: unknown): Y.Doc {
  const doc = new Y.Doc();
  doc.getMap("epic").set(EPOCH_KEY, value);
  return doc;
}

/** `doc` as a replica that only decoded its bytes holds it: no root typed. */
function coldReplay(doc: Y.Doc): Y.Doc {
  const replay = new Y.Doc();
  Y.applyUpdate(replay, Y.encodeStateAsUpdate(doc));
  return replay;
}

interface SelectionCase {
  readonly name: string;
  readonly build: () => Y.Doc;
  readonly expected: ArtifactIndexSelection;
}

const CASES: ReadonlyArray<SelectionCase> = [
  {
    name: "an empty document",
    build: () => new Y.Doc(),
    expected: { state: "ready", epoch: 0 },
  },
  {
    name: "a legacy row with no epoch",
    build: legacyDoc,
    expected: { state: "ready", epoch: 0 },
  },
  {
    name: "an epoch set only under another top-level map",
    build: () => {
      const doc = new Y.Doc();
      doc.getMap("root").set(EPOCH_KEY, 1);
      return doc;
    },
    expected: { state: "ready", epoch: 0 },
  },
  {
    name: "an epoch of 0",
    build: () => docWithEpoch(0),
    expected: { state: "unsupported-epoch" },
  },
  {
    name: "an epoch stored as undefined",
    build: () => docWithEpoch(undefined),
    expected: { state: "unsupported-epoch" },
  },
  {
    name: "an epoch of 2",
    build: () => docWithEpoch(2),
    expected: { state: "unsupported-epoch" },
  },
  {
    name: "an epoch stored as a string",
    build: () => docWithEpoch("1"),
    expected: { state: "unsupported-epoch" },
  },
  {
    name: "an epoch stored as a nested map",
    build: () => docWithEpoch(new Y.Map<unknown>()),
    expected: { state: "unsupported-epoch" },
  },
  {
    name: "an epoch written and removed over a legacy row",
    build: () => {
      const doc = legacyDoc();
      const epic = doc.getMap("epic");
      doc.transact(() => {
        epic.set(EPOCH_KEY, 1);
        epic.delete(EPOCH_KEY);
      });
      return doc;
    },
    expected: { state: "invalid-index" },
  },
  ...V1_ROOTS.flatMap((root): ReadonlyArray<SelectionCase> => [
    {
      name: `no epoch and a removed map entry in ${root}`,
      build: () => {
        const doc = new Y.Doc();
        doc.transact(() => {
          doc.getMap(root).set("removed", 1);
          doc.getMap(root).delete("removed");
        });
        return doc;
      },
      expected: { state: "invalid-index" },
    },
    {
      name: `no epoch and a removed sequence item in ${root}`,
      build: () => {
        const doc = new Y.Doc();
        doc.transact(() => {
          doc.getArray(root).push(["removed"]);
          doc.getArray(root).delete(0, 1);
        });
        return doc;
      },
      expected: { state: "invalid-index" },
    },
  ]),
];

describe("readArtifactIndexSelection", () => {
  it.each(CASES)(
    "reads $name the same live and from a cold replay",
    ({ build, expected }) => {
      const doc = build();

      expect(readArtifactIndexSelection(doc)).toEqual(expected);
      expect(readArtifactIndexSelection(coldReplay(doc))).toEqual(expected);
    },
  );

  it.each(V1_ROOTS)(
    "reads epoch 1 as ready while %s is a map, and as invalid once a peer's sequence lands in it",
    (root) => {
      const doc = docWithEpoch(1);
      doc.getMap(root);
      expect(readArtifactIndexSelection(doc)).toEqual({
        state: "ready",
        epoch: 1,
      });

      const peer = new Y.Doc();
      peer.getArray(root).push(["item"]);
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));

      expect(readArtifactIndexSelection(doc)).toEqual({
        state: "invalid-index",
      });
      expect(readArtifactIndexSelection(coldReplay(doc))).toEqual({
        state: "invalid-index",
      });
    },
  );

  // Live only: a root opened with nothing written to it has no bytes, so a
  // replay does not hold it.
  it("reads epoch 1 with a root opened as a sequence as invalid", () => {
    const doc = docWithEpoch(1);
    doc.getArray("artifactDeletionsV1");

    expect(readArtifactIndexSelection(doc)).toEqual({
      state: "invalid-index",
    });
  });
});
