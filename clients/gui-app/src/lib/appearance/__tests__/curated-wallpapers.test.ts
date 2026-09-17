// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downloadCuratedWallpaper,
  fetchCuratedWallpaperManifest,
  type CuratedWallpaper,
} from "../curated-wallpapers";

const MANIFEST_URL = "https://assets.traycer.ai/start-page/wallpapers/v1.json";

function validEntry(overrides: Partial<Record<string, unknown>>) {
  return {
    id: "dunes",
    title: "Dunes",
    full: {
      path: "blobs/sha256/aa11.webp",
      sha256: "a".repeat(64),
      bytes: 1024,
    },
    thumb: { path: "blobs/sha256/aa11-thumb.webp" },
    ...overrides,
  };
}

function jsonResponse(
  body: unknown,
  init: { readonly status?: number },
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

describe("fetchCuratedWallpaperManifest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses a valid v1 manifest into absolute URLs on assets.traycer.ai", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ version: 1, wallpapers: [validEntry({})] }, {}),
        ),
    );

    const wallpapers = await fetchCuratedWallpaperManifest(
      new AbortController().signal,
    );

    expect(wallpapers).toEqual([
      {
        id: "dunes",
        title: "Dunes",
        fullUrl:
          "https://assets.traycer.ai/start-page/wallpapers/blobs/sha256/aa11.webp",
        thumbUrl:
          "https://assets.traycer.ai/start-page/wallpapers/blobs/sha256/aa11-thumb.webp",
        sha256: "a".repeat(64),
        bytes: 1024,
      },
    ]);
  });

  it("issues the request with credentials omitted and no referrer", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ version: 1, wallpapers: [] }, {}));
    vi.stubGlobal("fetch", fetchMock);

    await fetchCuratedWallpaperManifest(new AbortController().signal);

    expect(fetchMock).toHaveBeenCalledWith(
      MANIFEST_URL,
      expect.objectContaining({
        credentials: "omit",
        referrerPolicy: "no-referrer",
      }),
    );
  });

  it("throws the status message for a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({}, { status: 500 })),
    );

    await expect(
      fetchCuratedWallpaperManifest(new AbortController().signal),
    ).rejects.toThrow(/\(500\)/);
  });

  it("throws the size-limit message for a body over 256 KiB", async () => {
    const oversized = "x".repeat(256 * 1024 + 1);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(oversized, {
          status: 200,
          headers: { "content-length": String(oversized.length) },
        }),
      ),
    );

    await expect(
      fetchCuratedWallpaperManifest(new AbortController().signal),
    ).rejects.toThrow(
      "The wallpaper catalog is larger than this build accepts.",
    );
  });

  const rejectedManifests: ReadonlyArray<[string, unknown]> = [
    [
      "an absolute off-origin path",
      {
        version: 1,
        wallpapers: [
          validEntry({
            full: {
              path: "https://evil.example/x.webp",
              sha256: "a".repeat(64),
              bytes: 1024,
            },
          }),
        ],
      },
    ],
    [
      "a rooted path",
      {
        version: 1,
        wallpapers: [
          validEntry({
            full: { path: "/rooted.webp", sha256: "a".repeat(64), bytes: 1024 },
          }),
        ],
      },
    ],
    [
      "a path that escapes with ..",
      {
        version: 1,
        wallpapers: [
          validEntry({
            full: {
              path: "../escape.webp",
              sha256: "a".repeat(64),
              bytes: 1024,
            },
          }),
        ],
      },
    ],
    [
      "a duplicate id",
      {
        version: 1,
        wallpapers: [validEntry({}), validEntry({ title: "Dunes 2" })],
      },
    ],
    ["an unsupported version", { version: 2, wallpapers: [] }],
  ];

  it.each(rejectedManifests)(
    "rejects the whole manifest for %s",
    async (_label, body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body, {})));

      await expect(
        fetchCuratedWallpaperManifest(new AbortController().signal),
      ).rejects.toThrow("The wallpaper catalog could not be read.");
    },
  );
});

describe("downloadCuratedWallpaper", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function entryFor(bytes: Uint8Array, sha256: string): CuratedWallpaper {
    return {
      id: "dunes",
      title: "Dunes",
      fullUrl:
        "https://assets.traycer.ai/start-page/wallpapers/blobs/sha256/aa11.webp",
      thumbUrl:
        "https://assets.traycer.ai/start-page/wallpapers/blobs/sha256/aa11-thumb.webp",
      sha256,
      bytes: bytes.byteLength,
    };
  }

  it("returns a Blob typed from content-type when the SHA-256 matches", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const hash = await sha256Hex(bytes);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(bytes, {
          status: 200,
          headers: { "content-type": "image/webp" },
        }),
      ),
    );

    const blob = await downloadCuratedWallpaper(
      entryFor(bytes, hash),
      new AbortController().signal,
    );

    expect(blob.type).toBe("image/webp");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  });

  it("falls back to image/webp when content-type is missing", async () => {
    const bytes = new Uint8Array([9, 9, 9]);
    const hash = await sha256Hex(bytes);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(bytes, { status: 200 })),
    );

    const blob = await downloadCuratedWallpaper(
      entryFor(bytes, hash),
      new AbortController().signal,
    );

    expect(blob.type).toBe("image/webp");
  });

  it("throws the integrity message on a SHA-256 mismatch", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(bytes, {
          status: 200,
          headers: { "content-type": "image/webp" },
        }),
      ),
    );

    await expect(
      downloadCuratedWallpaper(
        entryFor(bytes, "0".repeat(64)),
        new AbortController().signal,
      ),
    ).rejects.toThrow(
      "The downloaded wallpaper failed its integrity check. Try again.",
    );
  });

  it("throws when the body exceeds the catalog's declared bytes", async () => {
    const bytes = new Uint8Array(16);
    const hash = await sha256Hex(bytes);
    const entry = { ...entryFor(bytes, hash), bytes: 4 };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(bytes, {
          status: 200,
          headers: {
            "content-type": "image/webp",
            "content-length": String(bytes.byteLength),
          },
        }),
      ),
    );

    await expect(
      downloadCuratedWallpaper(entry, new AbortController().signal),
    ).rejects.toThrow(
      "The wallpaper download is larger than the catalog declared.",
    );
  });
});
