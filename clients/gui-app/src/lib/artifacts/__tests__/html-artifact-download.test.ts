import { describe, expect, it, vi } from "vitest";
import { unzipSync } from "fflate";
import {
  createHtmlArtifactZip,
  htmlArtifactZipName,
} from "@/lib/artifacts/html-artifact-download";
import type {
  ArtifactManifest,
  ArtifactReadSpan,
} from "@/lib/sandbox/artifact-serving";

const encoder = new TextEncoder();

const hashOf = (label: string): string => label.padEnd(64, "0").slice(0, 64);

interface SnapshotFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

function snapshotFile(path: string, bytes: Uint8Array): SnapshotFile {
  return { path, sha256: hashOf(`a${path.length}${bytes.byteLength}`), bytes };
}

function manifestOf(files: readonly SnapshotFile[]): ArtifactManifest {
  return {
    files: Object.fromEntries(
      files.map((file) => [
        file.path,
        {
          sha256: file.sha256,
          byteLength: file.bytes.byteLength,
          mediaType: "application/octet-stream",
        },
      ]),
    ),
  };
}

interface RecordedRead {
  readonly sha256: string;
  readonly offset: number;
  readonly length: number;
}

/** Serves the snapshot bytes exactly as the host's ranged object read would. */
function snapshotReader(files: readonly SnapshotFile[]): {
  readonly readSpan: ArtifactReadSpan;
  readonly reads: RecordedRead[];
} {
  const reads: RecordedRead[] = [];
  const readSpan: ArtifactReadSpan = (sha256, offset, length) => {
    reads.push({ sha256, offset, length });
    const file = files.find((candidate) => candidate.sha256 === sha256);
    if (file === undefined) {
      return Promise.resolve({ unavailable: "missing" });
    }
    return Promise.resolve({
      bytes: file.bytes.slice(offset, offset + length),
      totalBytes: file.bytes.byteLength,
      mediaType: "application/octet-stream",
    });
  };
  return { readSpan, reads };
}

async function unzip(blob: Blob): Promise<Record<string, Uint8Array>> {
  return unzipSync(new Uint8Array(await blob.arrayBuffer()));
}

// fflate and the test runner can hold different Uint8Array realms, which
// toEqual refuses to treat as equal even when every byte matches.
function bytesOf(entries: Record<string, Uint8Array>, path: string): number[] {
  if (!Object.hasOwn(entries, path)) {
    throw new Error(`The ZIP has no entry for ${path}.`);
  }
  return Array.from(entries[path]);
}

describe("createHtmlArtifactZip", () => {
  it("archives every page, nested asset and binary file as the raw captured bytes", async () => {
    // Not valid UTF-8, and large enough to need several ranged reads.
    const binary = Uint8Array.from(
      { length: 600 * 1024 + 17 },
      (_, index) => (index * 7) % 256,
    );
    const files = [
      snapshotFile(
        "index.html",
        encoder.encode("<script src=js/app.js></script>"),
      ),
      snapshotFile("pages/about/index.html", encoder.encode("<h1>About</h1>")),
      snapshotFile("css/site.css", encoder.encode("body{color:red}")),
      snapshotFile("js/app.js", encoder.encode("window.ready=true")),
      snapshotFile("assets/photo.bin", binary),
    ];
    const { readSpan, reads } = snapshotReader(files);

    const blob = await createHtmlArtifactZip({
      manifest: manifestOf(files),
      readSpan,
      signal: new AbortController().signal,
    });

    expect(blob.type).toBe("application/zip");
    const entries = await unzip(blob);
    expect(Object.keys(entries).sort()).toEqual(
      files.map((file) => file.path).sort(),
    );
    for (const file of files) {
      expect(bytesOf(entries, file.path)).toEqual(Array.from(file.bytes));
    }
    // Each file is read by its snapshot hash, in contiguous ranges from 0.
    for (const file of files) {
      const fileReads = reads.filter((read) => read.sha256 === file.sha256);
      expect(fileReads.length).toBeGreaterThan(0);
      let expectedOffset = 0;
      for (const read of fileReads) {
        expect(read.offset).toBe(expectedOffset);
        expectedOffset += read.length;
      }
      expect(expectedOffset).toBe(file.bytes.byteLength);
    }
    expect(
      reads.filter((read) => read.sha256 === files[4].sha256).length,
    ).toBeGreaterThan(1);
  });

  it("archives an empty file after proving its object is readable", async () => {
    const files = [
      snapshotFile("index.html", encoder.encode("<p>hi</p>")),
      snapshotFile("assets/empty.txt", new Uint8Array(0)),
    ];
    const { readSpan, reads } = snapshotReader(files);

    const entries = await unzip(
      await createHtmlArtifactZip({
        manifest: manifestOf(files),
        readSpan,
        signal: new AbortController().signal,
      }),
    );

    expect(bytesOf(entries, "assets/empty.txt")).toEqual([]);
    expect(
      reads.some(
        (read) => read.sha256 === files[1].sha256 && read.offset === 0,
      ),
    ).toBe(true);
  });

  describe("rejects before reading any object", () => {
    async function expectRejectedUnread(
      manifest: ArtifactManifest,
      message: RegExp,
    ): Promise<void> {
      const readSpan = vi.fn<ArtifactReadSpan>();
      await expect(
        createHtmlArtifactZip({
          manifest,
          readSpan,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(message);
      expect(readSpan).not.toHaveBeenCalled();
    }

    it("when the uncompressed total exceeds 64 MiB", async () => {
      const half = 32 * 1024 * 1024;
      await expectRejectedUnread(
        {
          files: {
            "index.html": {
              sha256: hashOf("a"),
              byteLength: half,
              mediaType: "text/html",
            },
            "big.bin": {
              sha256: hashOf("b"),
              byteLength: half + 1,
              mediaType: "application/octet-stream",
            },
          },
        },
        /too large/,
      );
    });

    it("when the manifest has more than 4096 files", async () => {
      const files = Object.fromEntries(
        Array.from({ length: 4097 }, (_, index) => [
          `f${index}.txt`,
          { sha256: hashOf("c"), byteLength: 1, mediaType: "text/plain" },
        ]),
      );
      await expectRejectedUnread({ files }, /too many files/);
    });

    it.each([
      "../escape.html",
      ".hidden/index.html",
      "a//b.html",
      "dir\\file.html",
      "c:evil.html",
    ])("when a path cannot be exported safely: %s", async (path) => {
      await expectRejectedUnread(
        {
          files: {
            [path]: {
              sha256: hashOf("d"),
              byteLength: 1,
              mediaType: "text/html",
            },
          },
        },
        /cannot be exported/,
      );
    });
  });

  describe("never offers a partial bundle", () => {
    const files = [
      snapshotFile("index.html", encoder.encode("<p>complete</p>")),
    ];
    const manifest = manifestOf(files);

    function download(readSpan: ArtifactReadSpan): Promise<Blob> {
      return createHtmlArtifactZip({
        manifest,
        readSpan,
        signal: new AbortController().signal,
      });
    }

    it("when the host no longer has an object", async () => {
      await expect(
        download(() => Promise.resolve({ unavailable: "evicted" })),
      ).rejects.toThrow(/unavailable/);
    });

    it("when a read comes back truncated", async () => {
      await expect(
        download(() =>
          Promise.resolve({
            bytes: files[0].bytes.slice(0, 3),
            totalBytes: files[0].bytes.byteLength,
            mediaType: "text/html",
          }),
        ),
      ).rejects.toThrow(/could not be read completely/);
    });

    it("when the object's reported size disagrees with the snapshot", async () => {
      await expect(
        download(() =>
          Promise.resolve({
            bytes: files[0].bytes,
            totalBytes: files[0].bytes.byteLength + 1,
            mediaType: "text/html",
          }),
        ),
      ).rejects.toThrow(/could not be read completely/);
    });
  });

  it("stops reading once the signal aborts", async () => {
    const files = [
      snapshotFile("index.html", encoder.encode("<p>one</p>")),
      snapshotFile("second.html", encoder.encode("<p>two</p>")),
    ];
    const controller = new AbortController();
    const served = snapshotReader(files);
    const readSpan: ArtifactReadSpan = async (...args) => {
      const result = await served.readSpan(...args);
      controller.abort();
      return result;
    };

    await expect(
      createHtmlArtifactZip({
        manifest: manifestOf(files),
        readSpan,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(served.reads).toHaveLength(1);
  });
});

describe("htmlArtifactZipName", () => {
  it("keeps a readable title and falls back when nothing safe remains", () => {
    expect(htmlArtifactZipName("Quarterly / report: Q3.")).toBe(
      "artifact-Quarterly report Q3.zip",
    );
    expect(htmlArtifactZipName("///")).toBe("artifact-bundle.zip");
  });
});
