import { afterEach, expect, it, vi } from "vitest";
import { ManifestStemSource } from "../stems";
import { makeAudioBuffer } from "./audio-buffer";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("reissues an expired recording once and shares the decoded asset across concurrent and later loads", async () => {
  const fetcher = vi.fn((url: string) =>
    Promise.resolve(
      new Response(new ArrayBuffer(4), {
        status: url === "https://example.test/piece.opus?old" ? 403 : 200,
      }),
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  const decode = vi.fn(() => Promise.resolve(makeAudioBuffer(3, 10)));
  const reissue = vi.fn(() =>
    Promise.resolve({
      tracks: [],
      recordings: [
        { name: "master", file: "https://example.test/piece.opus?fresh" },
      ],
    }),
  );
  const source = new ManifestStemSource(
    {
      tracks: [],
      recordings: [
        { name: "master", file: "https://example.test/piece.opus?old" },
      ],
    },
    { decode },
    reissue,
  );

  const [first, second] = await Promise.all([
    source.loadRecording("master"),
    source.loadRecording("master"),
  ]);
  expect(second).toBe(first);
  expect(await source.loadRecording("master")).toBe(first);
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    "https://example.test/piece.opus?old",
    "https://example.test/piece.opus?fresh",
  ]);
  expect(reissue).toHaveBeenCalledTimes(1);
  expect(decode).toHaveBeenCalledTimes(1);
});
