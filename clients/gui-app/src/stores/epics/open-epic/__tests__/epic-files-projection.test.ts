/**
 * Cover for the epic-files manifest projection (D02): the `files` sibling
 * Y.Map, `getEpicFilesMap` / `projectEpicFilesSlice` in
 * `projection-helpers.ts`, and the SECOND observation root the projector
 * attaches in `epic-projector.ts`.
 *
 * Drives a real store + Y.Doc through `openStoreForTest`, the same harness
 * `artifact-search-availability.test.tsx` uses, and writes manifest entries
 * straight onto `handle.doc.getMap("files")` the way the host would - plain
 * JSON values, never a `Y.Map`, matching what `epicFileEntrySchema.safeParse`
 * expects to read back.
 */
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";

/** Minimal stream client: this suite drives the doc directly, never the wire. */
const inertStreamFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => {},
  awareness: () => {},
  applyArtifactRoomUpdate: () => {},
  artifactRoomAwareness: () => {},
  retryMigration: () => {},
  close: () => {},
});

let opened: OpenedStoreForTest | null = null;

afterEach(() => {
  opened?.dispose();
  opened = null;
});

function openStore(): OpenedStoreForTest {
  const handle = openStoreForTest({
    epicId: "epic-files",
    userId: null,
    factories: {
      streamClientFactory: inertStreamFactory,
      laneSelection: null,
    },
    writeCommand: null,
  });
  opened = handle;
  return handle;
}

/**
 * A minimal, schema-valid manifest entry. Only the fields the schema has no
 * default for are required (`v`, `kind`, `current`, `status`) - `versions`,
 * `recordingId`, `derivedFrom` and `deletedAt` are filled in by
 * `epicFileEntrySchema`'s own defaults on parse, exactly as a lenient reader
 * against an older writer would see them.
 */
function entryValue(args: {
  readonly sha256: string;
  readonly status: string;
  readonly deletedAt: number | null;
}): Record<string, unknown> {
  return {
    v: 1,
    kind: "file",
    current: {
      sha256: args.sha256,
      byteLength: 100,
      mediaType: "text/plain",
      createdAt: 0,
      createdBy: "user-1",
      producer: { type: "user" },
    },
    status: args.status,
    deletedAt: args.deletedAt,
  };
}

const SHA_A = "1".repeat(64);
const SHA_B = "2".repeat(64);
const SHA_C = "3".repeat(64);

function setFileEntry(
  handle: OpenedStoreForTest,
  path: string,
  value: unknown,
): void {
  act(() => {
    handle.doc.getMap("files").set(path, value);
  });
}

describe("epic-files manifest projection against a real store + Y.Doc", () => {
  it("projects an added entry into files.records, sorted by path regardless of insertion order", () => {
    const handle = openStore();
    setFileEntry(
      handle,
      "files/z.txt",
      entryValue({ sha256: SHA_A, status: "available", deletedAt: null }),
    );
    setFileEntry(
      handle,
      "files/a.txt",
      entryValue({ sha256: SHA_B, status: "available", deletedAt: null }),
    );

    const { records } = handle.store.getState().files;
    expect(records.map((record) => record.path)).toEqual([
      "files/a.txt",
      "files/z.txt",
    ]);
    expect(records[0].entry.current.sha256).toBe(SHA_B);
    expect(records[1].entry.current.sha256).toBe(SHA_A);
  });

  it("skips an entry that fails the manifest schema without blanking the slice, and skips a non-files/ key", () => {
    const handle = openStore();
    setFileEntry(
      handle,
      "files/good.txt",
      entryValue({ sha256: SHA_A, status: "available", deletedAt: null }),
    );
    // Missing `current` - fails `epicFileEntrySchema`.
    setFileEntry(handle, "files/bad-object.txt", { nope: 1 });
    // Not an object at all - fails the same way.
    setFileEntry(handle, "files/bad-string.txt", "not an entry");
    // A legal-looking value under a key `isEpicFilePath` rejects.
    setFileEntry(
      handle,
      "artifacts/x.png",
      entryValue({ sha256: SHA_B, status: "available", deletedAt: null }),
    );

    const { records } = handle.store.getState().files;
    expect(records.map((record) => record.path)).toEqual(["files/good.txt"]);
  });

  it("splits a tombstoned entry into deleted, absent from records", () => {
    const handle = openStore();
    setFileEntry(
      handle,
      "files/live.txt",
      entryValue({ sha256: SHA_A, status: "available", deletedAt: null }),
    );
    setFileEntry(
      handle,
      "files/gone.txt",
      entryValue({ sha256: SHA_B, status: "available", deletedAt: 123 }),
    );

    const { records, deleted } = handle.store.getState().files;
    expect(records.map((record) => record.path)).toEqual(["files/live.txt"]);
    expect(deleted.map((record) => record.path)).toEqual(["files/gone.txt"]);
    expect(deleted[0].entry.deletedAt).toBe(123);
  });

  it("updating one entry leaves the sibling record's reference identical, and gives the changed one a new reference", () => {
    const handle = openStore();
    setFileEntry(
      handle,
      "files/a.txt",
      entryValue({ sha256: SHA_A, status: "available", deletedAt: null }),
    );
    setFileEntry(
      handle,
      "files/b.txt",
      entryValue({ sha256: SHA_B, status: "available", deletedAt: null }),
    );

    const before = handle.store.getState().files;
    const bBefore = before.records.find(
      (record) => record.path === "files/b.txt",
    );
    const aBefore = before.records.find(
      (record) => record.path === "files/a.txt",
    );
    expect(bBefore).toBeDefined();
    expect(aBefore).toBeDefined();

    setFileEntry(
      handle,
      "files/a.txt",
      entryValue({ sha256: SHA_A, status: "failed", deletedAt: null }),
    );

    const after = handle.store.getState().files;
    const bAfter = after.records.find(
      (record) => record.path === "files/b.txt",
    );
    const aAfter = after.records.find(
      (record) => record.path === "files/a.txt",
    );

    expect(bAfter).toBe(bBefore);
    expect(aAfter).not.toBe(aBefore);
    expect(aAfter?.entry.status).toBe("failed");
  });

  it("writing an unchanged entry leaves the whole files slice identical", () => {
    const handle = openStore();
    const value = entryValue({
      sha256: SHA_A,
      status: "available",
      deletedAt: null,
    });
    setFileEntry(handle, "files/a.txt", value);

    const before = handle.store.getState().files;

    // Same content, written again - a fresh plain object each time (never the
    // same reference), so only field-by-field equality can make this a no-op.
    setFileEntry(
      handle,
      "files/a.txt",
      entryValue({ sha256: SHA_A, status: "available", deletedAt: null }),
    );

    const after = handle.store.getState().files;
    expect(after).toBe(before);
  });

  it("does not disturb state.artifacts or state.tree, since files is a separate observation root", () => {
    const handle = openStore();
    const before = handle.store.getState();
    const artifactsBefore = before.artifacts;
    const treeBefore = before.tree;

    setFileEntry(
      handle,
      "files/a.txt",
      entryValue({ sha256: SHA_A, status: "available", deletedAt: null }),
    );

    const after = handle.store.getState();
    expect(after.artifacts).toBe(artifactsBefore);
    expect(after.tree).toBe(treeBefore);
  });

  it("does not throw when the doc is written to again after dispose", () => {
    const handle = openStore();
    setFileEntry(
      handle,
      "files/a.txt",
      entryValue({ sha256: SHA_A, status: "available", deletedAt: null }),
    );
    const doc = handle.doc;
    handle.dispose();
    opened = null;

    expect(() => {
      doc
        .getMap("files")
        .set(
          "files/c.txt",
          entryValue({ sha256: SHA_C, status: "available", deletedAt: null }),
        );
    }).not.toThrow();
  });
});
