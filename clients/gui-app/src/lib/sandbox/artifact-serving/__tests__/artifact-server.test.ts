// @vitest-environment node
//
// Pure data/logic over ArtifactServer, no DOM needed: running under jsdom
// would put this file's own `new TextEncoder().encode(...)` / `new
// Uint8Array(...)` literals and the production code's internal byte
// construction in different realms, and toEqual on cross-realm typed arrays
// can fail even when the bytes are identical.
import { Buffer } from "node:buffer";
import {
  EPIC_READ_FILE_RANGE_MAX_BYTES,
  EPIC_READ_FILE_TEXT_MAX_BYTES,
} from "@traycer/protocol/host/epic/files";
import { describe, expect, it, vi } from "vitest";
import { buildArtifactAddress, parseArtifactAddress } from "../artifact-address";
import { buildArtifactDocument, type ArtifactDocumentOptions } from "../artifact-document";
import type { ArtifactManifest, ArtifactManifestEntry } from "../artifact-manifest";
import { ArtifactServer, type ArtifactReadSpanResult } from "../artifact-server";

const FOUR_MIB = EPIC_READ_FILE_RANGE_MAX_BYTES;
const TWENTY_FIVE_MIB = EPIC_READ_FILE_TEXT_MAX_BYTES;

const DOCUMENT_OPTIONS: ArtifactDocumentOptions = {
  policySource: "traycer-sandbox:",
  csp: null,
  nonce: "n-1",
  shortcuts: [],
  theme: {
    appliesToRoot: true,
    colorScheme: "dark",
    background: null,
    variables: {},
  },
};

function entry(overrides: Partial<ArtifactManifestEntry>): ArtifactManifestEntry {
  return {
    sha256: "sha-1",
    byteLength: 10,
    mediaType: "application/octet-stream",
    ...overrides,
  };
}

function manifestWith(path: string, value: ArtifactManifestEntry): ArtifactManifest {
  return { files: { [path]: value } };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

/** A promise this test settles by hand, to pin down ordering without timers. */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Exact byte comparison for large (multi-MiB) slices. `toEqual` on a typed
 * array that size runs vitest's generic deep-equal, which is both slow and,
 * cross-realm, unreliable; `Buffer.equals` is a direct memory comparison.
 */
function bytesMatch(actual: Uint8Array, expected: Uint8Array): boolean {
  return Buffer.from(actual).equals(Buffer.from(expected));
}

/** A readSpan that hands back exactly the slice it is asked for from `full`. */
function spanOf(full: Uint8Array, mediaType: string) {
  return vi.fn(
    (
      _sha: string,
      offset: number,
      length: number,
    ): Promise<ArtifactReadSpanResult> =>
      Promise.resolve({
        bytes: full.slice(offset, offset + length),
        totalBytes: full.length,
        mediaType,
      }),
  );
}

describe("ArtifactServer.serve — request validation", () => {
  const manifest = manifestWith("index.html", entry({}));

  it.each(["", "../secret", ".hidden", "a\\b"])(
    "refuses the invalid path %j as missing, before touching the manifest",
    async (path) => {
      const readSpan = vi.fn();
      const server = new ArtifactServer({ treePath: "", manifest, readSpan, document: DOCUMENT_OPTIONS });
      const result = await server.serve({ path, offset: 0, length: 1, signal: signal() });
      expect(result).toEqual({ kind: "unavailable", reason: "missing", status: 404 });
      expect(readSpan).not.toHaveBeenCalled();
    },
  );

  it.each<[string, number, number]>([
    ["a negative offset", -1, 1],
    ["a non-integer offset", 1.5, 1],
    ["a NaN offset", Number.NaN, 1],
    ["a zero length", 0, 0],
    ["a negative length", 0, -1],
    ["a non-integer length", 0, 1.5],
  ])("refuses %s as invalid-range", async (_label, offset, length) => {
    const readSpan = vi.fn();
    const server = new ArtifactServer({ treePath: "", manifest, readSpan, document: DOCUMENT_OPTIONS });
    const result = await server.serve({ path: "index.html", offset, length, signal: signal() });
    expect(result).toEqual({ kind: "unavailable", reason: "invalid-range", status: 404 });
    expect(readSpan).not.toHaveBeenCalled();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "treats an entry with byteLength %j as invalid-size, a 503",
    async (byteLength) => {
      const readSpan = vi.fn();
      const server = new ArtifactServer({ treePath: "",
        manifest: manifestWith("index.html", entry({ byteLength })),
        readSpan,
        document: DOCUMENT_OPTIONS,
      });
      const result = await server.serve({ path: "index.html", offset: 0, length: 1, signal: signal() });
      expect(result).toEqual({ kind: "unavailable", reason: "invalid-size", status: 503 });
    },
  );

  it("rejects an already-aborted request instead of resolving", async () => {
    const controller = new AbortController();
    controller.abort();
    const server = new ArtifactServer({ treePath: "", manifest, readSpan: vi.fn(), document: DOCUMENT_OPTIONS });
    await expect(
      server.serve({ path: "index.html", offset: 0, length: 1, signal: controller.signal }),
    ).rejects.toThrow();
  });
});

describe("ArtifactServer.serve — manifest and outside resolver", () => {
  it("never consults the outside resolver when the manifest already has the path", async () => {
    const inManifest = entry({ sha256: "sha-manifest" });
    const readSpan = spanOf(new Uint8Array(10), inManifest.mediaType);
    const resolveOutsideReference = vi.fn();
    const server = new ArtifactServer({ treePath: "",
      manifest: manifestWith("a.bin", inManifest),
      readSpan,
      document: DOCUMENT_OPTIONS,
      resolveOutsideReference,
    });

    await server.serve({ path: "a.bin", offset: 0, length: 5, signal: signal() });

    expect(resolveOutsideReference).not.toHaveBeenCalled();
    // The port is asked to fill the whole (10-byte) block, not the caller's
    // smaller requested range.
    expect(readSpan).toHaveBeenCalledWith("sha-manifest", 0, 10, expect.anything());
  });

  it("falls back to the outside resolver only on a manifest miss", async () => {
    const outside = entry({ sha256: "sha-outside", byteLength: 10 });
    const readSpan = spanOf(new Uint8Array(10), outside.mediaType);
    const resolveOutsideReference = vi.fn(() => outside);
    const server = new ArtifactServer({ treePath: "",
      manifest: manifestWith("a.bin", entry({})),
      readSpan,
      document: DOCUMENT_OPTIONS,
      resolveOutsideReference,
    });

    const result = await server.serve({ path: "elsewhere.bin", offset: 0, length: 5, signal: signal() });

    expect(resolveOutsideReference).toHaveBeenCalledTimes(1);
    expect(resolveOutsideReference).toHaveBeenCalledWith("elsewhere.bin");
    expect(readSpan).toHaveBeenCalledWith("sha-outside", 0, 10, expect.anything());
    expect(result.kind).toBe("bytes");
  });

  it("is missing, 404, with no resolver configured at all", async () => {
    const server = new ArtifactServer({ treePath: "",
      manifest: manifestWith("a.bin", entry({})),
      readSpan: vi.fn(),
      document: DOCUMENT_OPTIONS,
    });
    const result = await server.serve({ path: "elsewhere.bin", offset: 0, length: 5, signal: signal() });
    expect(result).toEqual({ kind: "unavailable", reason: "missing", status: 404 });
  });

  it("is missing, 404, when the outside resolver itself returns null", async () => {
    const resolveOutsideReference = vi.fn(() => null);
    const server = new ArtifactServer({ treePath: "",
      manifest: manifestWith("a.bin", entry({})),
      readSpan: vi.fn(),
      document: DOCUMENT_OPTIONS,
      resolveOutsideReference,
    });
    const result = await server.serve({ path: "elsewhere.bin", offset: 0, length: 5, signal: signal() });
    expect(resolveOutsideReference).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ kind: "unavailable", reason: "missing", status: 404 });
  });
});

describe("ArtifactServer.serve — entry status", () => {
  // ArtifactManifestEntry itself carries no status field; this proves
  // serve() reads the manifest structurally and does not key off one even
  // when some other part of the system stamps a richer object onto it -
  // whether the port can actually produce bytes right now is entirely
  // readSpan's call.
  it.each(["queued", "uploading", "local-only"])(
    "still serves bytes for an entry carrying an unrelated status field (%s), once the local port can produce them",
    async (status) => {
      const bytes = new TextEncoder().encode("hello");
      const readSpan = spanOf(bytes, "text/plain");
      const entryWithStatus = { ...entry({ byteLength: bytes.length }), status };
      const server = new ArtifactServer({
        treePath: "",
        manifest: manifestWith("a.bin", entryWithStatus),
        readSpan,
        document: DOCUMENT_OPTIONS,
      });

      const result = await server.serve({ path: "a.bin", offset: 0, length: 100, signal: signal() });

      expect(result.kind).toBe("bytes");
      if (result.kind === "bytes") {
        expect(new TextDecoder().decode(result.bytes)).toBe("hello");
      }
    },
  );
});

describe("ArtifactServer.serve — raw bytes", () => {
  it("returns an empty slice at exactly EOF for a non-empty file, without reading", async () => {
    const readSpan = vi.fn();
    const server = new ArtifactServer({ treePath: "",
      manifest: manifestWith("a.bin", entry({ byteLength: 10 })),
      readSpan,
      document: DOCUMENT_OPTIONS,
    });
    const result = await server.serve({ path: "a.bin", offset: 10, length: 100, signal: signal() });
    expect(result).toEqual({
      kind: "bytes",
      bytes: new Uint8Array(),
      offset: 10,
      totalBytes: 10,
      mediaType: "application/octet-stream",
    });
    expect(readSpan).not.toHaveBeenCalled();
  });

  it("is invalid-range, 404, past EOF, without reading", async () => {
    const readSpan = vi.fn();
    const server = new ArtifactServer({ treePath: "",
      manifest: manifestWith("a.bin", entry({ byteLength: 10 })),
      readSpan,
      document: DOCUMENT_OPTIONS,
    });
    const result = await server.serve({ path: "a.bin", offset: 11, length: 100, signal: signal() });
    expect(result).toEqual({ kind: "unavailable", reason: "invalid-range", status: 404 });
    expect(readSpan).not.toHaveBeenCalled();
  });

  it("caps a single read at 4 MiB even when more is requested and available", async () => {
    const byteLength = 50 * 1024 * 1024;
    const readSpan = vi.fn(
      (_sha: string, _offset: number, length: number): Promise<ArtifactReadSpanResult> =>
        Promise.resolve({
          bytes: new Uint8Array(length),
          totalBytes: byteLength,
          mediaType: "application/octet-stream",
        }),
    );
    const server = new ArtifactServer({ treePath: "",
      manifest: manifestWith("big.bin", entry({ byteLength })),
      readSpan,
      document: DOCUMENT_OPTIONS,
    });

    const result = await server.serve({
      path: "big.bin",
      offset: 0,
      length: 20 * 1024 * 1024,
      signal: signal(),
    });

    expect(readSpan).toHaveBeenCalledWith("sha-1", 0, FOUR_MIB, expect.anything());
    expect(result).toMatchObject({ kind: "bytes", totalBytes: byteLength });
    if (result.kind === "bytes") expect(result.bytes.length).toBe(FOUR_MIB);
  });

  it("reuses a cached block for growing requests within it, and reads only the new block when crossing into one", async () => {
    const byteLength = FOUR_MIB * 2;
    const readSpan = vi.fn(
      (_sha: string, _offset: number, length: number): Promise<ArtifactReadSpanResult> =>
        Promise.resolve({
          bytes: new Uint8Array(length),
          totalBytes: byteLength,
          mediaType: "application/octet-stream",
        }),
    );
    const server = new ArtifactServer({ treePath: "",
      manifest: manifestWith("big.bin", entry({ byteLength })),
      readSpan,
      document: DOCUMENT_OPTIONS,
    });

    await server.serve({ path: "big.bin", offset: 0, length: 1000, signal: signal() });
    expect(readSpan).toHaveBeenCalledTimes(1);
    // The port fills the whole first block, not just the 1000 bytes asked for.
    expect(readSpan).toHaveBeenCalledWith("sha-1", 0, FOUR_MIB, expect.anything());

    const smaller = await server.serve({ path: "big.bin", offset: 0, length: 500, signal: signal() });
    expect(readSpan).toHaveBeenCalledTimes(1); // same block already cached
    if (smaller.kind === "bytes") expect(smaller.bytes.length).toBe(500);

    const bigger = await server.serve({ path: "big.bin", offset: 0, length: FOUR_MIB, signal: signal() });
    expect(readSpan).toHaveBeenCalledTimes(1); // still the same cached block
    if (bigger.kind === "bytes") expect(bigger.bytes.length).toBe(FOUR_MIB);

    // Crossing into the second block needs exactly one more read, for that
    // block alone.
    const crossing = await server.serve({
      path: "big.bin",
      offset: FOUR_MIB - 10,
      length: 20,
      signal: signal(),
    });
    expect(readSpan).toHaveBeenCalledTimes(2);
    expect(readSpan).toHaveBeenLastCalledWith("sha-1", FOUR_MIB, FOUR_MIB, expect.anything());
    if (crossing.kind === "bytes") expect(crossing.bytes.length).toBe(20);

    // The second block is cached too now; revisiting it needs no more reads.
    await server.serve({ path: "big.bin", offset: FOUR_MIB, length: 1000, signal: signal() });
    expect(readSpan).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest untouched cached span once the 64 MiB budget is exceeded, while a touched entry survives", async () => {
    const byteLength = 100 * 1024 * 1024;
    const readSpan = vi.fn(
      (_sha: string, _offset: number, length: number): Promise<ArtifactReadSpanResult> =>
        Promise.resolve({
          bytes: new Uint8Array(length),
          totalBytes: byteLength,
          mediaType: "application/octet-stream",
        }),
    );
    const server = new ArtifactServer({ treePath: "",
      manifest: manifestWith("big.bin", entry({ byteLength })),
      readSpan,
      document: DOCUMENT_OPTIONS,
    });
    const at = (offset: number) =>
      server.serve({ path: "big.bin", offset, length: FOUR_MIB, signal: signal() });

    // Fill the cache to exactly its budget: 16 spans of 4 MiB each.
    for (let index = 0; index < 16; index += 1) {
      await at(index * FOUR_MIB);
    }
    expect(readSpan).toHaveBeenCalledTimes(16);

    // Touching offset 0 again is a cache hit, and makes it the newest entry.
    await at(0);
    expect(readSpan).toHaveBeenCalledTimes(16);

    // A 17th distinct span pushes the cache over its 64 MiB budget: the
    // oldest UNTOUCHED entry (offset 4 MiB, not offset 0) is evicted.
    await at(16 * FOUR_MIB);
    expect(readSpan).toHaveBeenCalledTimes(17);

    await at(FOUR_MIB); // evicted: must read again
    expect(readSpan).toHaveBeenCalledTimes(18);

    await at(0); // still cached: no new read
    expect(readSpan).toHaveBeenCalledTimes(18);
  });

  it("probes an empty file with a single 1-byte read and caches the resulting empty span", async () => {
    const readSpan = vi.fn(
      (_sha: string, offset: number, length: number): Promise<ArtifactReadSpanResult> => {
        expect(offset).toBe(0);
        expect(length).toBe(1);
        return Promise.resolve({ bytes: new Uint8Array(0), totalBytes: 0, mediaType: "application/octet-stream" });
      },
    );
    const server = new ArtifactServer({ treePath: "",
      manifest: manifestWith("empty.bin", entry({ byteLength: 0 })),
      readSpan,
      document: DOCUMENT_OPTIONS,
    });

    const first = await server.serve({ path: "empty.bin", offset: 0, length: 100, signal: signal() });
    expect(first).toEqual({
      kind: "bytes",
      bytes: new Uint8Array(),
      offset: 0,
      totalBytes: 0,
      mediaType: "application/octet-stream",
    });
    expect(readSpan).toHaveBeenCalledTimes(1);

    await server.serve({ path: "empty.bin", offset: 0, length: 5, signal: signal() });
    expect(readSpan).toHaveBeenCalledTimes(1);
  });

  it.each<[string, number, number, ArtifactReadSpanResult]>([
    [
      "returns non-empty bytes for a probed empty file (oversized)",
      0,
      1,
      { bytes: new Uint8Array(1), totalBytes: 0, mediaType: "application/octet-stream" },
    ],
    [
      "returns zero bytes for a non-empty file at a non-EOF offset (early-empty)",
      100,
      10,
      { bytes: new Uint8Array(0), totalBytes: 100, mediaType: "application/octet-stream" },
    ],
    [
      "returns more bytes than the whole block needs (oversized)",
      100,
      10,
      // The port fills the whole (100-byte) block regardless of the
      // caller's smaller requested length, so "oversized" means more than
      // the block's own remaining size - not more than the caller asked for.
      { bytes: new Uint8Array(150), totalBytes: 100, mediaType: "application/octet-stream" },
    ],
    [
      "disagrees with the manifest about the file's total size",
      100,
      10,
      { bytes: new Uint8Array(5), totalBytes: 99, mediaType: "application/octet-stream" },
    ],
  ])(
    "surfaces a malformed port span as invalid-span, 503, for: %s",
    async (_label, byteLength, requestLength, response) => {
      const readSpan = vi.fn((): Promise<ArtifactReadSpanResult> => Promise.resolve(response));
      const server = new ArtifactServer({ treePath: "",
        manifest: manifestWith("a.bin", entry({ byteLength })),
        readSpan,
        document: DOCUMENT_OPTIONS,
      });
      const result = await server.serve({
        path: "a.bin",
        offset: 0,
        length: requestLength,
        signal: signal(),
      });
      expect(result).toEqual({ kind: "unavailable", reason: "invalid-span", status: 503 });
    },
  );

  it("maps a port's 'missing' unavailability to 404, and anything else to 503, passing the reason through", async () => {
    const missing = vi.fn(
      (): Promise<ArtifactReadSpanResult> => Promise.resolve({ unavailable: "missing" }),
    );
    const other = vi.fn(
      (): Promise<ArtifactReadSpanResult> => Promise.resolve({ unavailable: "network-error" }),
    );
    const manifest = manifestWith("a.bin", entry({ byteLength: 10 }));

    const missingResult = await new ArtifactServer({ treePath: "",
      manifest,
      readSpan: missing,
      document: DOCUMENT_OPTIONS,
    }).serve({ path: "a.bin", offset: 0, length: 1, signal: signal() });
    expect(missingResult).toEqual({ kind: "unavailable", reason: "missing", status: 404 });

    const otherResult = await new ArtifactServer({ treePath: "",
      manifest,
      readSpan: other,
      document: DOCUMENT_OPTIONS,
    }).serve({ path: "a.bin", offset: 0, length: 1, signal: signal() });
    expect(otherResult).toEqual({ kind: "unavailable", reason: "network-error", status: 503 });
  });
});

describe("ArtifactServer.serve — HTML documents", () => {
  function htmlEntry(rawHtml: Uint8Array, overrides: Partial<ArtifactManifestEntry>) {
    return entry({
      sha256: "sha-html",
      byteLength: rawHtml.length,
      mediaType: "text/html; charset=utf-8",
      ...overrides,
    });
  }

  it("composes the loader document around the raw html, byte for byte matching buildArtifactDocument", async () => {
    const rawHtml = new TextEncoder().encode("<p>hi</p>");
    const e = htmlEntry(rawHtml, {});
    const readSpan = spanOf(rawHtml, e.mediaType);
    const server = new ArtifactServer({ treePath: "",
      manifest: manifestWith("index.html", e),
      readSpan,
      document: DOCUMENT_OPTIONS,
    });

    // The composed document carries the full loader prelude (the inlined
    // Figtree font alone is ~20 KB), so request the full 4 MiB cap to be
    // sure of capturing all of it in one call.
    const result = await server.serve({ path: "index.html", offset: 0, length: FOUR_MIB, signal: signal() });

    const expected = buildArtifactDocument("<p>hi</p>", DOCUMENT_OPTIONS);
    expect(result.kind).toBe("bytes");
    if (result.kind === "bytes") {
      expect(new TextDecoder().decode(result.bytes)).toBe(expected);
      expect(result.mediaType).toBe("text/html; charset=utf-8");
      expect(result.totalBytes).toBe(new TextEncoder().encode(expected).length);
    }
  });

  it("slices a composed document across multiple requests and reassembles it exactly, reading the source only once", async () => {
    const rawHtml = new TextEncoder().encode("<p>hello artifact world</p>");
    const e = htmlEntry(rawHtml, {});
    const readSpan = spanOf(rawHtml, e.mediaType);
    const server = new ArtifactServer({ treePath: "",
      manifest: manifestWith("index.html", e),
      readSpan,
      document: DOCUMENT_OPTIONS,
    });

    const expectedBytes = new TextEncoder().encode(
      buildArtifactDocument("<p>hello artifact world</p>", DOCUMENT_OPTIONS),
    );
    const mid = Math.floor(expectedBytes.length / 2);

    const first = await server.serve({ path: "index.html", offset: 0, length: mid, signal: signal() });
    const second = await server.serve({
      path: "index.html",
      offset: mid,
      length: expectedBytes.length - mid,
      signal: signal(),
    });

    expect(readSpan).toHaveBeenCalledTimes(1);
    if (first.kind === "bytes" && second.kind === "bytes") {
      const combined = new Uint8Array(first.bytes.length + second.bytes.length);
      combined.set(first.bytes, 0);
      combined.set(second.bytes, first.bytes.length);
      expect(combined).toEqual(expectedBytes);
    } else {
      throw new Error("expected both slices to succeed");
    }
  });

  it("reads a document larger than one range chunk across multiple reads and composes it correctly", async () => {
    const size = FOUR_MIB * 2 + 123;
    const rawHtml = new TextEncoder().encode("a".repeat(size));
    const e = htmlEntry(rawHtml, {});
    const readSpan = spanOf(rawHtml, e.mediaType);
    const server = new ArtifactServer({ treePath: "",
      manifest: manifestWith("index.html", e),
      readSpan,
      document: DOCUMENT_OPTIONS,
    });

    const expectedBytes = new TextEncoder().encode(
      buildArtifactDocument("a".repeat(size), DOCUMENT_OPTIONS),
    );
    const totalLength = expectedBytes.length; // > 2 * FOUR_MIB, prelude included

    // A single serve() call is capped at 4 MiB of RESPONSE bytes even for a
    // composed document, so requesting the "whole" document still only
    // returns its first chunk.
    const firstChunk = await server.serve({
      path: "index.html",
      offset: 0,
      length: totalLength,
      signal: signal(),
    });

    expect(readSpan).toHaveBeenCalledTimes(3);
    expect(readSpan).toHaveBeenNthCalledWith(1, "sha-html", 0, FOUR_MIB, expect.anything());
    expect(readSpan).toHaveBeenNthCalledWith(2, "sha-html", FOUR_MIB, FOUR_MIB, expect.anything());
    expect(readSpan).toHaveBeenNthCalledWith(3, "sha-html", FOUR_MIB * 2, 123, expect.anything());
    if (firstChunk.kind !== "bytes") throw new Error("expected the composed document");
    expect(bytesMatch(firstChunk.bytes, expectedBytes.subarray(0, FOUR_MIB))).toBe(true);

    // Further ranges, including one straddling the first chunk's boundary,
    // are served from the already-composed, cached document: no more reads
    // of the underlying source.
    const acrossBoundary = await server.serve({
      path: "index.html",
      offset: FOUR_MIB - 100,
      length: 200,
      signal: signal(),
    });
    const secondChunk = await server.serve({
      path: "index.html",
      offset: FOUR_MIB,
      length: FOUR_MIB,
      signal: signal(),
    });
    const tail = await server.serve({
      path: "index.html",
      offset: FOUR_MIB * 2,
      length: totalLength - FOUR_MIB * 2,
      signal: signal(),
    });
    expect(readSpan).toHaveBeenCalledTimes(3); // no extra source reads

    if (acrossBoundary.kind !== "bytes" || secondChunk.kind !== "bytes" || tail.kind !== "bytes") {
      throw new Error("expected every further slice to succeed");
    }
    expect(
      bytesMatch(acrossBoundary.bytes, expectedBytes.subarray(FOUR_MIB - 100, FOUR_MIB + 100)),
    ).toBe(true);
    expect(bytesMatch(secondChunk.bytes, expectedBytes.subarray(FOUR_MIB, FOUR_MIB * 2))).toBe(true);
    expect(bytesMatch(tail.bytes, expectedBytes.subarray(FOUR_MIB * 2, totalLength))).toBe(true);

    const reconstructed = new Uint8Array(totalLength);
    reconstructed.set(firstChunk.bytes, 0);
    reconstructed.set(secondChunk.bytes, FOUR_MIB);
    reconstructed.set(tail.bytes, FOUR_MIB * 2);
    expect(bytesMatch(reconstructed, expectedBytes)).toBe(true);
  });

  it("caches the composed document by sha, and recomposes once its own manifest entry's sha changes for the same path", async () => {
    // An outside reference is always served raw now (never composed), so
    // this exercises the own-path cache invalidation through a live,
    // mutable manifest instead: the server reads `files` fresh on every
    // call, so swapping the entry under the same key simulates the
    // referenced artifact changing underneath that path.
    const htmlA = new TextEncoder().encode("<p>a</p>");
    const htmlB = new TextEncoder().encode("<p>bb</p>");
    const files: Record<string, ArtifactManifestEntry> = {
      "page.html": htmlEntry(htmlA, { sha256: "sha-a" }),
    };
    const readSpan = vi.fn(
      (sha: string, offset: number, length: number): Promise<ArtifactReadSpanResult> => {
        const source = sha === "sha-a" ? htmlA : htmlB;
        return Promise.resolve({
          bytes: source.slice(offset, offset + length),
          totalBytes: source.length,
          mediaType: "text/html",
        });
      },
    );
    const server = new ArtifactServer({
      treePath: "",
      manifest: { files },
      readSpan,
      document: DOCUMENT_OPTIONS,
    });

    // Full-document comparisons below need the whole composed document (the
    // inlined font alone is ~20 KB), so request the 4 MiB cap each time.
    const first = await server.serve({ path: "page.html", offset: 0, length: FOUR_MIB, signal: signal() });
    expect(readSpan).toHaveBeenCalledTimes(1);
    const again = await server.serve({ path: "page.html", offset: 0, length: FOUR_MIB, signal: signal() });
    expect(readSpan).toHaveBeenCalledTimes(1); // same sha: still cached
    expect(again).toEqual(first);

    files["page.html"] = htmlEntry(htmlB, { sha256: "sha-b" });
    const changed = await server.serve({ path: "page.html", offset: 0, length: FOUR_MIB, signal: signal() });
    expect(readSpan).toHaveBeenCalledTimes(2); // different sha for the same path: recomposed
    if (first.kind !== "bytes" || changed.kind !== "bytes") {
      throw new Error("expected both compositions to succeed");
    }
    expect(new TextDecoder().decode(changed.bytes)).toBe(buildArtifactDocument("<p>bb</p>", DOCUMENT_OPTIONS));
    expect(new TextDecoder().decode(first.bytes)).toBe(buildArtifactDocument("<p>a</p>", DOCUMENT_OPTIONS));
  });

  it("refuses a document over 25 MiB as document-too-large, 503, without reading", async () => {
    const readSpan = vi.fn();
    const server = new ArtifactServer({ treePath: "",
      manifest: manifestWith("index.html", htmlEntry(new Uint8Array(0), { byteLength: TWENTY_FIVE_MIB + 1 })),
      readSpan,
      document: DOCUMENT_OPTIONS,
    });

    const result = await server.serve({ path: "index.html", offset: 0, length: 1, signal: signal() });

    expect(result).toEqual({ kind: "unavailable", reason: "document-too-large", status: 503 });
    expect(readSpan).not.toHaveBeenCalled();
  });

  it("composes the loader document around empty content for an empty html file, probing availability once", async () => {
    const readSpan = vi.fn(
      (_sha: string, offset: number, length: number): Promise<ArtifactReadSpanResult> => {
        expect(offset).toBe(0);
        expect(length).toBe(1);
        return Promise.resolve({ bytes: new Uint8Array(0), totalBytes: 0, mediaType: "text/html" });
      },
    );
    const server = new ArtifactServer({ treePath: "",
      manifest: manifestWith("index.html", htmlEntry(new Uint8Array(0), { byteLength: 0 })),
      readSpan,
      document: DOCUMENT_OPTIONS,
    });

    const expected = buildArtifactDocument("", DOCUMENT_OPTIONS);
    // The composed document is still the full loader prelude even for an
    // empty raw body, so request the 4 MiB cap to capture all of it.
    const result = await server.serve({ path: "index.html", offset: 0, length: FOUR_MIB, signal: signal() });
    expect(readSpan).toHaveBeenCalledTimes(1);
    if (result.kind === "bytes") {
      expect(new TextDecoder().decode(result.bytes)).toBe(expected);
    } else {
      throw new Error("expected the composed empty document");
    }

    await server.serve({ path: "index.html", offset: 0, length: 5, signal: signal() });
    expect(readSpan).toHaveBeenCalledTimes(1); // the composed document is cached too
  });

  it("surfaces a malformed early-empty span as unavailable instead of looping forever composing the document", async () => {
    const readSpan = vi.fn(
      (): Promise<ArtifactReadSpanResult> =>
        Promise.resolve({
          bytes: new Uint8Array(0), // never advances past offset 0
          totalBytes: 100,
          mediaType: "text/html",
        }),
    );
    const server = new ArtifactServer({ treePath: "",
      manifest: manifestWith("index.html", htmlEntry(new Uint8Array(0), { byteLength: 100 })),
      readSpan,
      document: DOCUMENT_OPTIONS,
    });

    const result = await server.serve({ path: "index.html", offset: 0, length: 10, signal: signal() });

    expect(result).toEqual({ kind: "unavailable", reason: "invalid-span", status: 503 });
    expect(readSpan).toHaveBeenCalledTimes(1);
  });

  it("returns an empty slice at exactly the composed document's EOF", async () => {
    const rawHtml = new TextEncoder().encode("<p>hi</p>");
    const e = htmlEntry(rawHtml, {});
    const readSpan = spanOf(rawHtml, e.mediaType);
    const server = new ArtifactServer({ treePath: "",
      manifest: manifestWith("index.html", e),
      readSpan,
      document: DOCUMENT_OPTIONS,
    });
    const expectedLength = new TextEncoder().encode(
      buildArtifactDocument("<p>hi</p>", DOCUMENT_OPTIONS),
    ).length;

    const result = await server.serve({
      path: "index.html",
      offset: expectedLength,
      length: 100,
      signal: signal(),
    });

    expect(result).toEqual({
      kind: "bytes",
      bytes: new Uint8Array(),
      offset: expectedLength,
      totalBytes: expectedLength,
      mediaType: "text/html; charset=utf-8",
    });
  });

  it("detects a document by media type alone, even without an .html path", async () => {
    const rawHtml = new TextEncoder().encode("<p>snapshot</p>");
    const e = entry({ byteLength: rawHtml.length, mediaType: "text/html; charset=UTF-8" });
    const readSpan = spanOf(rawHtml, e.mediaType);
    const server = new ArtifactServer({ treePath: "",
      manifest: manifestWith("snapshot.bin", e),
      readSpan,
      document: DOCUMENT_OPTIONS,
    });

    const result = await server.serve({ path: "snapshot.bin", offset: 0, length: 10_000, signal: signal() });

    expect(result.kind).toBe("bytes");
    if (result.kind === "bytes") expect(result.mediaType).toBe("text/html; charset=utf-8");
  });

  it("detects a document by its .html path alone, even with a generic media type", async () => {
    const rawHtml = new TextEncoder().encode("<p>snapshot</p>");
    const e = entry({ byteLength: rawHtml.length, mediaType: "application/octet-stream" });
    const readSpan = spanOf(rawHtml, e.mediaType);
    const server = new ArtifactServer({ treePath: "",
      manifest: manifestWith("index.html", e),
      readSpan,
      document: DOCUMENT_OPTIONS,
    });

    const result = await server.serve({ path: "index.html", offset: 0, length: 10_000, signal: signal() });

    expect(result.kind).toBe("bytes");
    if (result.kind === "bytes") expect(result.mediaType).toBe("text/html; charset=utf-8");
  });

  it("leaves a non-html file's own media type alone", async () => {
    const bytes = new TextEncoder().encode('{"a":1}');
    const e = entry({ byteLength: bytes.length, mediaType: "application/json" });
    const readSpan = spanOf(bytes, e.mediaType);
    const server = new ArtifactServer({ treePath: "",
      manifest: manifestWith("data.json", e),
      readSpan,
      document: DOCUMENT_OPTIONS,
    });

    const result = await server.serve({ path: "data.json", offset: 0, length: 100, signal: signal() });

    expect(result.kind).toBe("bytes");
    if (result.kind === "bytes") expect(result.mediaType).toBe("application/json");
  });
});

describe("ArtifactServer.serve — shared cache concurrency", () => {
  it("coalesces concurrent cold requests for the same block into a single port call", async () => {
    const gate = deferred<ArtifactReadSpanResult>();
    const readSpan = vi.fn(() => gate.promise);
    const server = new ArtifactServer({ treePath: "",
      manifest: manifestWith("a.bin", entry({ byteLength: 10 })),
      readSpan,
      document: DOCUMENT_OPTIONS,
    });

    // Both requests reach the shared block's coalesce key before either one
    // is awaited, so they must share one port call.
    const first = server.serve({ path: "a.bin", offset: 0, length: 5, signal: signal() });
    const second = server.serve({ path: "a.bin", offset: 2, length: 3, signal: signal() });
    expect(readSpan).toHaveBeenCalledTimes(1);

    gate.resolve({ bytes: new Uint8Array(10), totalBytes: 10, mediaType: "application/octet-stream" });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(readSpan).toHaveBeenCalledTimes(1);
    expect(firstResult.kind).toBe("bytes");
    expect(secondResult.kind).toBe("bytes");
    if (firstResult.kind === "bytes") expect(firstResult.bytes.length).toBe(5);
    if (secondResult.kind === "bytes") expect(secondResult.bytes.length).toBe(3);
  });

  it("charges a concurrently loaded block once within the byte budget", async () => {
    const gate = deferred<ArtifactReadSpanResult>();
    const totalBytes = 16 * FOUR_MIB;
    const readSpan = vi.fn(
      (_sha: string, offset: number, length: number): Promise<ArtifactReadSpanResult> =>
        offset === 0
          ? gate.promise
          : Promise.resolve({ bytes: new Uint8Array(length), totalBytes, mediaType: "application/octet-stream" }),
    );
    const server = new ArtifactServer({ treePath: "",
      manifest: manifestWith("asset.bin", entry({ byteLength: totalBytes })),
      readSpan,
      document: DOCUMENT_OPTIONS,
    });
    const at = (offset: number) =>
      server.serve({ path: "asset.bin", offset, length: 1, signal: signal() });
    const first = at(0);
    const second = at(1);
    gate.resolve({ bytes: new Uint8Array(FOUR_MIB), totalBytes, mediaType: "application/octet-stream" });
    await Promise.all([first, second]);
    for (let index = 1; index < 16; index += 1) await at(index * FOUR_MIB);
    expect(readSpan).toHaveBeenCalledTimes(16);
    // Sixteen blocks fit exactly. Double-charging the first would evict it.
    await at(0);
    expect(readSpan).toHaveBeenCalledTimes(16);
  });

  it("evicts composed documents under the shared byte budget, below the entry-count limit", async () => {
    const byteLength = 2 * FOUR_MIB;
    const files: Record<string, ArtifactManifestEntry> = {};
    for (let index = 0; index < 5; index += 1) {
      files[`page-${index}.html`] = entry({ sha256: `doc-${index}`, byteLength, mediaType: "text/html" });
    }
    const readSpan = vi.fn(
      (_sha: string, _offset: number, length: number): Promise<ArtifactReadSpanResult> =>
        Promise.resolve({ bytes: new Uint8Array(length).fill(97), totalBytes: byteLength, mediaType: "text/html" }),
    );
    const server = new ArtifactServer({ treePath: "", manifest: { files }, readSpan, document: DOCUMENT_OPTIONS });
    const at = (index: number) =>
      server.serve({ path: `page-${index}.html`, offset: 0, length: 1, signal: signal() });
    for (let index = 0; index < 5; index += 1) {
      expect((await at(index)).kind).toBe("bytes");
    }
    expect(readSpan).toHaveBeenCalledTimes(10);
    await at(4);
    expect(readSpan).toHaveBeenCalledTimes(10);
    // Only fifteen entries were inserted. Eviction must be due to bytes.
    await at(0);
    expect(readSpan).toHaveBeenCalledTimes(12);
  });

  it("lets one waiter's abort fail just that request, without aborting the shared port read or any other waiter", async () => {
    const gate = deferred<ArtifactReadSpanResult>();
    const readSpan = vi.fn(() => gate.promise);
    const server = new ArtifactServer({ treePath: "",
      manifest: manifestWith("a.bin", entry({ byteLength: 10 })),
      readSpan,
      document: DOCUMENT_OPTIONS,
    });

    const abortedController = new AbortController();
    const aborted = server.serve({
      path: "a.bin",
      offset: 0,
      length: 5,
      signal: abortedController.signal,
    });
    const survivor = server.serve({ path: "a.bin", offset: 0, length: 5, signal: signal() });
    expect(readSpan).toHaveBeenCalledTimes(1);

    abortedController.abort(new Error("gone"));
    await expect(aborted).rejects.toThrow();

    // The underlying port read is still outstanding - nobody cancelled it -
    // and resolving it now still serves the other waiter.
    gate.resolve({ bytes: new Uint8Array(10), totalBytes: 10, mediaType: "application/octet-stream" });
    const survivorResult = await survivor;

    expect(readSpan).toHaveBeenCalledTimes(1);
    expect(survivorResult.kind).toBe("bytes");
    if (survivorResult.kind === "bytes") expect(survivorResult.bytes.length).toBe(5);
  });

  it("serves many tiny, distinct offsets within one block from a single port read", async () => {
    const byteLength = 10_000; // well under one 4 MiB block
    const readSpan = vi.fn(
      (_sha: string, _offset: number, length: number): Promise<ArtifactReadSpanResult> =>
        Promise.resolve({
          bytes: new Uint8Array(length),
          totalBytes: byteLength,
          mediaType: "application/octet-stream",
        }),
    );
    const server = new ArtifactServer({ treePath: "",
      manifest: manifestWith("a.bin", entry({ byteLength })),
      readSpan,
      document: DOCUMENT_OPTIONS,
    });

    for (const offset of [0, 37, 500, 1500, 4000, 8000, 9999]) {
      const result = await server.serve({ path: "a.bin", offset, length: 1, signal: signal() });
      expect(result.kind).toBe("bytes");
    }

    expect(readSpan).toHaveBeenCalledTimes(1);
  });

  it("keeps cache accounting correct when a pending block resolves after other blocks have already filled and evicted within the shared budget", async () => {
    const pendingByteLength = FOUR_MIB;
    const otherByteLength = FOUR_MIB * 17;
    const gate = deferred<ArtifactReadSpanResult>();
    const readSpan = vi.fn(
      (sha: string, _offset: number, length: number): Promise<ArtifactReadSpanResult> => {
        if (sha === "sha-pending") return gate.promise;
        return Promise.resolve({
          bytes: new Uint8Array(length),
          totalBytes: otherByteLength,
          mediaType: "application/octet-stream",
        });
      },
    );
    const manifest: ArtifactManifest = {
      files: {
        "pending.bin": entry({ sha256: "sha-pending", byteLength: pendingByteLength }),
        "other.bin": entry({ sha256: "sha-other", byteLength: otherByteLength }),
      },
    };
    const server = new ArtifactServer({ treePath: "", manifest, readSpan, document: DOCUMENT_OPTIONS });

    // Start, but do not await, a read whose port call never settles yet.
    const pending = server.serve({ path: "pending.bin", offset: 0, length: FOUR_MIB, signal: signal() });
    expect(readSpan).toHaveBeenCalledTimes(1);

    // 17 already-settled blocks of another file fill the cache past its 64
    // MiB budget on their own, evicting the oldest of themselves (block 0).
    for (let index = 0; index < 17; index += 1) {
      await server.serve({ path: "other.bin", offset: index * FOUR_MIB, length: FOUR_MIB, signal: signal() });
    }
    expect(readSpan).toHaveBeenCalledTimes(18); // 1 pending + 17 settled

    // Now let the pending block resolve: inserting it evicts the next
    // oldest survivor rather than corrupting the running byte total.
    gate.resolve({
      bytes: new Uint8Array(FOUR_MIB),
      totalBytes: pendingByteLength,
      mediaType: "application/octet-stream",
    });
    const pendingResult = await pending;
    expect(pendingResult.kind).toBe("bytes");
    expect(readSpan).toHaveBeenCalledTimes(18); // the pending port call itself was already counted

    // The oldest surviving block (other.bin's block 1) was evicted to make
    // room for the pending block; re-requesting it reads again.
    await server.serve({ path: "other.bin", offset: FOUR_MIB, length: FOUR_MIB, signal: signal() });
    expect(readSpan).toHaveBeenCalledTimes(19);

    // The most recently inserted "other" block, and the pending block
    // itself, are both still cached.
    const callsBeforeFinalChecks = 19;
    await server.serve({ path: "other.bin", offset: 16 * FOUR_MIB, length: FOUR_MIB, signal: signal() });
    await server.serve({ path: "pending.bin", offset: 0, length: FOUR_MIB, signal: signal() });
    expect(readSpan).toHaveBeenCalledTimes(callsBeforeFinalChecks);
  });

  it("reuses an already-composed document for a different path with the same sha and size", async () => {
    const htmlBytes = new TextEncoder().encode("<p>hi</p>");
    const readSpan = spanOf(htmlBytes, "text/html");
    const sharedEntry = entry({ sha256: "sha-shared", byteLength: htmlBytes.length, mediaType: "text/html" });
    const manifest: ArtifactManifest = { files: { "a.html": sharedEntry, "b.html": sharedEntry } };
    const server = new ArtifactServer({ treePath: "", manifest, readSpan, document: DOCUMENT_OPTIONS });

    const first = await server.serve({ path: "a.html", offset: 0, length: FOUR_MIB, signal: signal() });
    expect(readSpan).toHaveBeenCalledTimes(1);

    const second = await server.serve({ path: "b.html", offset: 0, length: FOUR_MIB, signal: signal() });
    expect(readSpan).toHaveBeenCalledTimes(1); // same sha + size: composition reused, not reread

    if (first.kind !== "bytes" || second.kind !== "bytes") {
      throw new Error("expected both paths to resolve to the composed document");
    }
    expect(bytesMatch(second.bytes, first.bytes)).toBe(true);
  });

  it("evicts within the shared 1024-entry cap across many small HTML documents", async () => {
    const readSpan = vi.fn(
      (): Promise<ArtifactReadSpanResult> =>
        Promise.resolve({ bytes: new Uint8Array(0), totalBytes: 0, mediaType: "text/html" }),
    );
    // 2 cache entries per document (its one empty block, plus the composed
    // document itself): comfortably past the shared 1024-entry cap.
    const COUNT = 520;
    const files: Record<string, ArtifactManifestEntry> = {};
    for (let index = 0; index < COUNT; index += 1) {
      files[`doc-${index}.html`] = entry({
        sha256: `sha-doc-${index}`,
        byteLength: 0,
        mediaType: "text/html",
      });
    }
    const server = new ArtifactServer({ treePath: "", manifest: { files }, readSpan, document: DOCUMENT_OPTIONS });

    for (let index = 0; index < COUNT; index += 1) {
      const result = await server.serve({
        path: `doc-${index}.html`,
        offset: 0,
        length: FOUR_MIB,
        signal: signal(),
      });
      expect(result.kind).toBe("bytes");
    }
    expect(readSpan).toHaveBeenCalledTimes(COUNT);

    // The earliest documents were pushed out by the shared entry-count cap.
    const callsBeforeEarliest = readSpan.mock.calls.length;
    const revisitEarliest = await server.serve({
      path: "doc-0.html",
      offset: 0,
      length: FOUR_MIB,
      signal: signal(),
    });
    expect(revisitEarliest.kind).toBe("bytes");
    expect(readSpan.mock.calls.length).toBeGreaterThan(callsBeforeEarliest);

    // The most recently composed document is still cached.
    const callsBeforeLatest = readSpan.mock.calls.length;
    const revisitLatest = await server.serve({
      path: `doc-${COUNT - 1}.html`,
      offset: 0,
      length: FOUR_MIB,
      signal: signal(),
    });
    expect(revisitLatest.kind).toBe("bytes");
    expect(readSpan.mock.calls.length).toBe(callsBeforeLatest);
  });
});

describe("ArtifactServer.serve — tree-path nesting", () => {
  it("serves its own nested html, with the tree prefix stripped before the manifest lookup", async () => {
    const rawHtml = new TextEncoder().encode("<p>nested</p>");
    const ownEntry = entry({
      sha256: "sha-nested-html",
      byteLength: rawHtml.length,
      mediaType: "text/html",
    });
    const readSpan = spanOf(rawHtml, ownEntry.mediaType);
    const server = new ArtifactServer({
      treePath: "parent/report",
      // Keyed by the artifact-relative path, not the full tree path the
      // caller sends.
      manifest: manifestWith("index.html", ownEntry),
      readSpan,
      document: DOCUMENT_OPTIONS,
    });

    const result = await server.serve({
      path: "parent/report/index.html",
      offset: 0,
      length: FOUR_MIB,
      signal: signal(),
    });

    expect(result.kind).toBe("bytes");
    if (result.kind === "bytes") {
      expect(result.mediaType).toBe("text/html; charset=utf-8");
      expect(new TextDecoder().decode(result.bytes)).toBe(
        buildArtifactDocument("<p>nested</p>", DOCUMENT_OPTIONS),
      );
    }
  });

  it("serves its own nested raw asset, with the tree prefix stripped before the manifest lookup", async () => {
    const bytes = new TextEncoder().encode("binary-ish");
    const ownEntry = entry({
      sha256: "sha-nested-asset",
      byteLength: bytes.length,
      mediaType: "application/octet-stream",
    });
    const readSpan = spanOf(bytes, ownEntry.mediaType);
    const server = new ArtifactServer({
      treePath: "parent/report",
      manifest: manifestWith("assets/logo.png", ownEntry),
      readSpan,
      document: DOCUMENT_OPTIONS,
    });

    const result = await server.serve({
      path: "parent/report/assets/logo.png",
      offset: 0,
      length: 100,
      signal: signal(),
    });

    expect(result.kind).toBe("bytes");
    if (result.kind === "bytes") {
      expect(result.mediaType).toBe("application/octet-stream");
      expect(bytesMatch(result.bytes, bytes)).toBe(true);
    }
  });

  it("falls back to the outside resolver with the full tree path for a sibling resolved via relative URL, and serves it raw", async () => {
    const entryUrl = buildArtifactAddress({ origin: "traycer-artifact://artifact-myart--mountabc1234567890", artifactId: "myart", mountId: "mountabc1234567890", treePath: "parent/report", path: "index.html" });
    const siblingUrl = new URL("../other/clip.mp4", entryUrl).href;
    const sibling = parseArtifactAddress(siblingUrl);
    if (sibling === null) throw new Error("expected the sibling URL to parse");
    expect(sibling.path).toBe("parent/other/clip.mp4");

    const clipBytes = new TextEncoder().encode("fake-mp4-bytes");
    const outsideEntry = entry({
      sha256: "sha-clip",
      byteLength: clipBytes.length,
      mediaType: "video/mp4",
    });
    const resolveOutsideReference = vi.fn(() => outsideEntry);
    const readSpan = spanOf(clipBytes, outsideEntry.mediaType);
    const server = new ArtifactServer({
      treePath: "parent/report",
      manifest: manifestWith("index.html", entry({ byteLength: 0 })), // irrelevant here
      readSpan,
      document: DOCUMENT_OPTIONS,
      resolveOutsideReference,
    });

    const result = await server.serve({ path: sibling.path, offset: 0, length: 100, signal: signal() });

    expect(resolveOutsideReference).toHaveBeenCalledWith("parent/other/clip.mp4");
    expect(result.kind).toBe("bytes");
    if (result.kind === "bytes") {
      expect(result.mediaType).toBe("video/mp4");
      expect(bytesMatch(result.bytes, clipBytes)).toBe(true);
    }
  });

  it.each(["parent/other/page.html", "parent/report/child/page.html"])(
    "serves outside HTML raw at %s, including a child under its own prefix",
    async (path) => {
    const rawHtmlLookingBytes = new TextEncoder().encode("<p>outside</p>");
    const outsideEntry = entry({
      sha256: "sha-outside-html",
      byteLength: rawHtmlLookingBytes.length,
      mediaType: "text/html",
    });
    const resolveOutsideReference = vi.fn(() => outsideEntry);
    const readSpan = spanOf(rawHtmlLookingBytes, outsideEntry.mediaType);
    const server = new ArtifactServer({
      treePath: "parent/report",
      manifest: { files: {} },
      readSpan,
      document: DOCUMENT_OPTIONS,
      resolveOutsideReference,
    });

    const result = await server.serve({
      path,
      offset: 0,
      length: FOUR_MIB,
      signal: signal(),
    });

    expect(resolveOutsideReference).toHaveBeenCalledWith(path);
    expect(result.kind).toBe("bytes");
    if (result.kind === "bytes") {
      // Raw, byte for byte - never run through buildArtifactDocument.
      expect(result.mediaType).toBe("text/html");
      expect(bytesMatch(result.bytes, rawHtmlLookingBytes)).toBe(true);
    }
  });

  it("does not let a sibling folder whose name merely starts with the tree path leak into the own manifest", async () => {
    const readSpan = vi.fn();
    const resolveOutsideReference = vi.fn(() => null);
    const server = new ArtifactServer({
      treePath: "report",
      // Both incorrect prefix-strip lengths must produce manifest hits, or
      // a lookup miss could hide a broken folder-boundary check.
      manifest: {
        files: {
          "-other/x": entry({ byteLength: 5 }),
          "other/x": entry({ byteLength: 5 }),
        },
      },
      readSpan,
      document: DOCUMENT_OPTIONS,
      resolveOutsideReference,
    });

    const result = await server.serve({ path: "report-other/x", offset: 0, length: 5, signal: signal() });

    expect(resolveOutsideReference).toHaveBeenCalledWith("report-other/x");
    expect(readSpan).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: "unavailable", reason: "missing", status: 404 });
  });

  it("still refuses a literal .. in the request path, before any tree-path or manifest logic runs", async () => {
    const readSpan = vi.fn();
    const resolveOutsideReference = vi.fn();
    const server = new ArtifactServer({
      treePath: "parent/report",
      manifest: { files: {} },
      readSpan,
      document: DOCUMENT_OPTIONS,
      resolveOutsideReference,
    });

    const result = await server.serve({
      path: "parent/report/../secret",
      offset: 0,
      length: 1,
      signal: signal(),
    });

    expect(result).toEqual({ kind: "unavailable", reason: "missing", status: 404 });
    expect(readSpan).not.toHaveBeenCalled();
    expect(resolveOutsideReference).not.toHaveBeenCalled();
  });
});
