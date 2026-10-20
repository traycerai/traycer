import { describe, expect, it, vi } from "vitest";
import type { ArtifactObjectRef } from "@traycer/protocol/persistence/epic/artifacts";
import type {
  ArtifactReadSpan,
  ArtifactReadSpanResult,
} from "@/lib/sandbox/artifact-serving/artifact-server";
import { readArtifactBlob } from "@/lib/files/read-artifact-blob";

// A four-byte range cap makes a small fixture span several requests, so the
// reader's offset arithmetic is exercised without allocating megabytes.
vi.mock(
  "@traycer/protocol/host/epic/artifact-objects",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@traycer/protocol/host/epic/artifact-objects")
    >()),
    EPIC_READ_ARTIFACT_OBJECT_RANGE_MAX_BYTES: 4,
  }),
);

const SHA = "a".repeat(64);

function objectOf(byteLength: number): ArtifactObjectRef {
  return {
    sha256: SHA,
    byteLength,
    mediaType: "application/octet-stream",
    status: "published",
  };
}

function bytesOf(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

/** Serves slices of `source` and records the spans it was asked for. */
function spanServer(source: Uint8Array, totalBytes: number) {
  const requests: Array<{ offset: number; length: number }> = [];
  const readSpan: ArtifactReadSpan = (_sha, offset, length) => {
    requests.push({ offset, length });
    return Promise.resolve({
      bytes: source.slice(offset, offset + length),
      totalBytes,
      mediaType: "application/octet-stream",
    });
  };
  return { readSpan, requests };
}

async function bytesOfBlob(blob: Blob): Promise<number[]> {
  return [...new Uint8Array(await blob.arrayBuffer())];
}

describe("readArtifactBlob", () => {
  it("reassembles an object larger than one range in order, asking for each span at the right offset", async () => {
    const source = bytesOf(1, 2, 3, 4, 5, 6, 7, 8, 9, 10);
    const { readSpan, requests } = spanServer(source, source.length);

    const blob = await readArtifactBlob(
      objectOf(source.length),
      readSpan,
      new AbortController().signal,
    );

    expect(requests).toEqual([
      { offset: 0, length: 4 },
      { offset: 4, length: 4 },
      { offset: 8, length: 2 },
    ]);
    expect(await bytesOfBlob(blob)).toEqual([...source]);
    expect(blob.type).toBe("application/octet-stream");
  });

  it("accepts a short span that still makes progress and asks again from where it stopped", async () => {
    const source = bytesOf(1, 2, 3, 4, 5, 6);
    const requests: number[] = [];
    const readSpan: ArtifactReadSpan = (_sha, offset) => {
      requests.push(offset);
      return Promise.resolve({
        bytes: source.slice(offset, offset + 2),
        totalBytes: source.length,
        mediaType: "application/octet-stream",
      });
    };

    const blob = await readArtifactBlob(
      objectOf(source.length),
      readSpan,
      new AbortController().signal,
    );

    expect(requests).toEqual([0, 2, 4]);
    expect(await bytesOfBlob(blob)).toEqual([...source]);
  });

  it("reads a zero-byte object with a single one-byte request and yields an empty blob", async () => {
    const { readSpan, requests } = spanServer(bytesOf(), 0);

    const blob = await readArtifactBlob(
      objectOf(0),
      readSpan,
      new AbortController().signal,
    );

    expect(requests).toEqual([{ offset: 0, length: 1 }]);
    expect(blob.size).toBe(0);
  });

  it.each<[string, ArtifactReadSpanResult]>([
    [
      "a total that disagrees with the object's recorded length",
      {
        bytes: bytesOf(1, 2, 3),
        totalBytes: 9,
        mediaType: "application/octet-stream",
      },
    ],
    [
      "an empty span before the end of the object",
      {
        bytes: bytesOf(),
        totalBytes: 3,
        mediaType: "application/octet-stream",
      },
    ],
    [
      "a span longer than the one requested",
      {
        bytes: bytesOf(1, 2, 3, 4, 5),
        totalBytes: 3,
        mediaType: "application/octet-stream",
      },
    ],
  ])(
    "refuses %s rather than painting a corrupt file",
    async (_label, served) => {
      await expect(
        readArtifactBlob(
          objectOf(3),
          () => Promise.resolve(served),
          new AbortController().signal,
        ),
      ).rejects.toThrow("incomplete");
    },
  );

  it("surfaces an unavailable host instead of an empty file", async () => {
    await expect(
      readArtifactBlob(
        objectOf(3),
        () => Promise.resolve({ unavailable: "host offline" }),
        new AbortController().signal,
      ),
    ).rejects.toThrow("unavailable");
  });

  it("does not request anything once the signal has aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const readSpan = vi.fn<ArtifactReadSpan>();

    await expect(
      readArtifactBlob(objectOf(3), readSpan, controller.signal),
    ).rejects.toThrow();
    expect(readSpan).not.toHaveBeenCalled();
  });

  it("drops bytes that arrive after the signal aborted mid-read", async () => {
    const controller = new AbortController();
    const readSpan: ArtifactReadSpan = () => {
      controller.abort();
      return Promise.resolve({
        bytes: bytesOf(1, 2, 3),
        totalBytes: 3,
        mediaType: "application/octet-stream",
      });
    };

    await expect(
      readArtifactBlob(objectOf(3), readSpan, controller.signal),
    ).rejects.toThrow();
  });
});
