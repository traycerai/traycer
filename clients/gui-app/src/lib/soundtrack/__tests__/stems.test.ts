import { afterEach, describe, expect, it, vi } from "vitest";
import { ManifestStemSource, type StemManifest } from "../stems";
import { AQUILO_1 } from "../variable-sound";
import { makeAudioBuffer } from "./audio-buffer";

const LAYER_C = AQUILO_1.layers[2];

const MANIFEST: StemManifest = {
  tracks: [
    {
      name: "aquilo-1",
      layers: [
        {
          name: "C",
          files: ["c1.ogg", "c2.ogg", "c3.ogg", "c4.ogg", "c5.ogg"],
        },
      ],
    },
  ],
};

// 32 Mi frames of one channel of 4-byte floats is 128 MiB, so four stems fill
// the 512 MiB budget exactly and a fifth overflows it.
const BIG_STEM_FRAMES = 32 * 1024 * 1024;

function stubFetch(status: (call: number) => number) {
  const fetchMock = vi.fn((_url: string) =>
    Promise.resolve(
      new Response(new ArrayBuffer(4), {
        status: status(fetchMock.mock.calls.length),
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return {
    urls: () => fetchMock.mock.calls.map(([url]) => url),
  };
}

function makeDecoder(frames: number) {
  return {
    decode: vi.fn(() => Promise.resolve(makeAudioBuffer(1, frames))),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ManifestStemSource", () => {
  it("maps variant n to files[n - 1]", async () => {
    const fetched = stubFetch(() => 200);
    const source = new ManifestStemSource(MANIFEST, makeDecoder(10));
    await source.load(AQUILO_1, LAYER_C, 1);
    await source.load(AQUILO_1, LAYER_C, 3);
    expect(fetched.urls()).toEqual(["c1.ogg", "c3.ogg"]);
  });

  it("rejects an unknown track, layer or variant without fetching", async () => {
    const fetched = stubFetch(() => 200);
    const source = new ManifestStemSource(MANIFEST, makeDecoder(10));
    await expect(
      source.load({ ...AQUILO_1, name: "other" }, LAYER_C, 1),
    ).rejects.toThrow();
    await expect(
      source.load(AQUILO_1, AQUILO_1.layers[0], 1),
    ).rejects.toThrow();
    await expect(source.load(AQUILO_1, LAYER_C, 6)).rejects.toThrow();
    await expect(source.load(AQUILO_1, LAYER_C, 0)).rejects.toThrow();
    expect(fetched.urls()).toEqual([]);
  });

  it("rejects when the response is not ok", async () => {
    stubFetch(() => 404);
    const decoder = makeDecoder(10);
    const source = new ManifestStemSource(MANIFEST, decoder);
    await expect(source.load(AQUILO_1, LAYER_C, 1)).rejects.toThrow("404");
    expect(decoder.decode).not.toHaveBeenCalled();
  });

  it("fetches once for concurrent loads of one file", async () => {
    const fetched = stubFetch(() => 200);
    const source = new ManifestStemSource(MANIFEST, makeDecoder(10));
    const [first, second] = await Promise.all([
      source.load(AQUILO_1, LAYER_C, 2),
      source.load(AQUILO_1, LAYER_C, 2),
    ]);
    expect(first).toBe(second);
    expect(fetched.urls()).toEqual(["c2.ogg"]);
  });

  it("does not fetch a decoded file again", async () => {
    const fetched = stubFetch(() => 200);
    const source = new ManifestStemSource(MANIFEST, makeDecoder(10));
    const first = await source.load(AQUILO_1, LAYER_C, 1);
    const second = await source.load(AQUILO_1, LAYER_C, 1);
    expect(second).toBe(first);
    expect(fetched.urls()).toEqual(["c1.ogg"]);
  });

  it("retries a failed load on the next call", async () => {
    const fetched = stubFetch((call) => (call === 1 ? 500 : 200));
    const source = new ManifestStemSource(MANIFEST, makeDecoder(10));
    await expect(source.load(AQUILO_1, LAYER_C, 1)).rejects.toThrow();
    await source.load(AQUILO_1, LAYER_C, 1);
    expect(fetched.urls()).toEqual(["c1.ogg", "c1.ogg"]);
  });

  it("evicts the least recently used stems past 512 MiB and keeps a recently used one", async () => {
    const fetched = stubFetch(() => 200);
    const source = new ManifestStemSource(
      MANIFEST,
      makeDecoder(BIG_STEM_FRAMES),
    );
    for (const variant of [1, 2, 3, 4]) {
      await source.load(AQUILO_1, LAYER_C, variant);
    }
    // Using the oldest makes the second oldest the least recently used.
    await source.load(AQUILO_1, LAYER_C, 1);
    await source.load(AQUILO_1, LAYER_C, 5);
    expect(fetched.urls()).toEqual([
      "c1.ogg",
      "c2.ogg",
      "c3.ogg",
      "c4.ogg",
      "c5.ogg",
    ]);

    await source.load(AQUILO_1, LAYER_C, 1);
    expect(fetched.urls()).toHaveLength(5);
    await source.load(AQUILO_1, LAYER_C, 2);
    expect(fetched.urls()).toHaveLength(6);
    expect(fetched.urls()[5]).toBe("c2.ogg");
  });
});
