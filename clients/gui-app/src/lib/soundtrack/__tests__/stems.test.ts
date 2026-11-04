import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ManifestStemSource,
  type StemManifest,
  type StemReissue,
} from "../stems";
import type { GroupedLayer } from "../variable-sound";
import { AQUILO_1 } from "./aquilo-1";
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

const noReissue: StemReissue = () => Promise.resolve(null);

const FRESH: StemManifest = {
  tracks: [
    {
      name: "aquilo-1",
      layers: [
        {
          name: "C",
          files: ["fresh/c1.ogg", "fresh/c2.ogg", "fresh/c3.ogg"],
        },
      ],
    },
  ],
};

/** Answers by the url asked for, so a stale link and a fresh one differ. */
function stubFetchByUrl(status: (url: string) => number) {
  const fetchMock = vi.fn((url: string) =>
    Promise.resolve(new Response(new ArrayBuffer(4), { status: status(url) })),
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
    const source = new ManifestStemSource(MANIFEST, makeDecoder(10), noReissue);
    await source.load(AQUILO_1, LAYER_C, 1);
    await source.load(AQUILO_1, LAYER_C, 3);
    expect(fetched.urls()).toEqual(["c1.ogg", "c3.ogg"]);
  });

  it("rejects an unknown track, layer or variant without fetching", async () => {
    const fetched = stubFetch(() => 200);
    const source = new ManifestStemSource(MANIFEST, makeDecoder(10), noReissue);
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
    const source = new ManifestStemSource(MANIFEST, decoder, noReissue);
    await expect(source.load(AQUILO_1, LAYER_C, 1)).rejects.toThrow("404");
    expect(decoder.decode).not.toHaveBeenCalled();
  });

  it("fetches once for concurrent loads of one file", async () => {
    const fetched = stubFetch(() => 200);
    const source = new ManifestStemSource(MANIFEST, makeDecoder(10), noReissue);
    const [first, second] = await Promise.all([
      source.load(AQUILO_1, LAYER_C, 2),
      source.load(AQUILO_1, LAYER_C, 2),
    ]);
    expect(first).toBe(second);
    expect(fetched.urls()).toEqual(["c2.ogg"]);
  });

  it("does not fetch a decoded file again", async () => {
    const fetched = stubFetch(() => 200);
    const source = new ManifestStemSource(MANIFEST, makeDecoder(10), noReissue);
    const first = await source.load(AQUILO_1, LAYER_C, 1);
    const second = await source.load(AQUILO_1, LAYER_C, 1);
    expect(second).toBe(first);
    expect(fetched.urls()).toEqual(["c1.ogg"]);
  });

  it("retries a failed load on the next call", async () => {
    const fetched = stubFetch((call) => (call === 1 ? 500 : 200));
    const source = new ManifestStemSource(MANIFEST, makeDecoder(10), noReissue);
    await expect(source.load(AQUILO_1, LAYER_C, 1)).rejects.toThrow();
    await source.load(AQUILO_1, LAYER_C, 1);
    expect(fetched.urls()).toEqual(["c1.ogg", "c1.ogg"]);
  });

  it("evicts the least recently used stems past 512 MiB and keeps a recently used one", async () => {
    const fetched = stubFetch(() => 200);
    const source = new ManifestStemSource(
      MANIFEST,
      makeDecoder(BIG_STEM_FRAMES),
      noReissue,
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

  it("loads a grouped layer's variant from its group's files", async () => {
    const fetched = stubFetch(() => 200);
    const grouped: GroupedLayer = {
      name: "G",
      groups: [
        { name: "EA1", variants: 3 },
        { name: "EA2", variants: 2 },
      ],
      sequence: ["EA1", "EA2"],
      sublayers: 1,
      sublayerStartingOffset: null,
      pan: null,
    };
    const source = new ManifestStemSource(
      {
        tracks: [
          {
            name: "aquilo-1",
            layers: [
              {
                name: "G",
                groups: [
                  { name: "EA1", files: ["a1.ogg", "a2.ogg", "a3.ogg"] },
                  { name: "EA2", files: ["b1.ogg", "b2.ogg"] },
                ],
              },
            ],
          },
        ],
      },
      makeDecoder(10),
      noReissue,
    );
    await source.load(AQUILO_1, grouped, 2);
    await source.load(AQUILO_1, grouped, 4);
    await source.load(AQUILO_1, grouped, 5);
    expect(fetched.urls()).toEqual(["a2.ogg", "b1.ogg", "b2.ogg"]);
  });

  describe("a refused link", () => {
    it.each([400, 403])(
      "answered %i asks again once and retries the sample on the fresh url",
      async (refused) => {
        const fetched = stubFetchByUrl((url) =>
          url.startsWith("fresh/") ? 200 : refused,
        );
        const reissue = vi.fn<StemReissue>(() => Promise.resolve(FRESH));
        const decoder = makeDecoder(10);
        const source = new ManifestStemSource(MANIFEST, decoder, reissue);

        await source.load(AQUILO_1, LAYER_C, 2);

        expect(reissue).toHaveBeenCalledTimes(1);
        expect(fetched.urls()).toEqual(["c2.ogg", "fresh/c2.ogg"]);
        expect(decoder.decode).toHaveBeenCalledTimes(1);
      },
    );

    it.each([404, 500])("answered %i does not ask again", async (refused) => {
      const fetched = stubFetchByUrl(() => refused);
      const reissue = vi.fn<StemReissue>(() => Promise.resolve(FRESH));
      const source = new ManifestStemSource(MANIFEST, makeDecoder(10), reissue);

      await expect(source.load(AQUILO_1, LAYER_C, 1)).rejects.toThrow(
        String(refused),
      );

      expect(reissue).not.toHaveBeenCalled();
      expect(fetched.urls()).toEqual(["c1.ogg"]);
    });

    it("rejects with the status and fetches nothing more when the re-ask has no links", async () => {
      const fetched = stubFetchByUrl(() => 403);
      const reissue = vi.fn<StemReissue>(() => Promise.resolve(null));
      const source = new ManifestStemSource(MANIFEST, makeDecoder(10), reissue);

      await expect(source.load(AQUILO_1, LAYER_C, 1)).rejects.toThrow("403");

      expect(reissue).toHaveBeenCalledTimes(1);
      expect(fetched.urls()).toEqual(["c1.ogg"]);
    });

    it("gives up on the sample when the fresh link is refused too", async () => {
      const fetched = stubFetchByUrl(() => 400);
      const reissue = vi.fn<StemReissue>(() => Promise.resolve(FRESH));
      const source = new ManifestStemSource(MANIFEST, makeDecoder(10), reissue);

      await expect(source.load(AQUILO_1, LAYER_C, 1)).rejects.toThrow("400");

      expect(reissue).toHaveBeenCalledTimes(1);
      expect(fetched.urls()).toEqual(["c1.ogg", "fresh/c1.ogg"]);
    });

    it("shares one re-ask between stems refused together", async () => {
      const fetched = stubFetchByUrl((url) =>
        url.startsWith("fresh/") ? 200 : 403,
      );
      const reissue = vi.fn<StemReissue>(() => Promise.resolve(FRESH));
      const source = new ManifestStemSource(MANIFEST, makeDecoder(10), reissue);

      await Promise.all(
        [1, 2, 3].map((v) => source.load(AQUILO_1, LAYER_C, v)),
      );

      expect(reissue).toHaveBeenCalledTimes(1);
      expect(fetched.urls().filter((url) => url.startsWith("fresh/"))).toEqual([
        "fresh/c1.ogg",
        "fresh/c2.ogg",
        "fresh/c3.ogg",
      ]);
    });

    it("does not fetch again a stem decoded before the re-ask", async () => {
      const fetched = stubFetchByUrl((url) => (url === "c2.ogg" ? 403 : 200));
      const reissue = vi.fn<StemReissue>(() => Promise.resolve(FRESH));
      const source = new ManifestStemSource(MANIFEST, makeDecoder(10), reissue);

      const first = await source.load(AQUILO_1, LAYER_C, 1);
      await source.load(AQUILO_1, LAYER_C, 2);
      const again = await source.load(AQUILO_1, LAYER_C, 1);

      expect(again).toBe(first);
      expect(fetched.urls()).toEqual(["c1.ogg", "c2.ogg", "fresh/c2.ogg"]);
    });

    it("names the stem in a rejection and never the url", async () => {
      stubFetchByUrl(() => 500);
      const secret = "https://bucket.test/c1.ogg?X-Goog-Signature=secret";
      const source = new ManifestStemSource(
        {
          tracks: [
            { name: "aquilo-1", layers: [{ name: "C", files: [secret] }] },
          ],
        },
        makeDecoder(10),
        noReissue,
      );

      const error = await source
        .load(AQUILO_1, LAYER_C, 1)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      const message = error instanceof Error ? error.message : "";
      expect(message).toContain("aquilo-1/C/1");
      expect(message).not.toContain("secret");
      expect(message).not.toContain("bucket.test");
    });
  });
});
