import { describe, expect, it } from "vitest";
import { parseRemoteManifest } from "../remote-manifest";
import { AQUILO_1 } from "./aquilo-1";

function mixedManifest() {
  return {
    version: 2,
    tracks: [
      { kind: "generative", ...AQUILO_1 },
      { kind: "composed", name: "piece", title: "Piece", recording: "master" },
    ],
    views: { home: ["piece", "aquilo-1"], task: [], bot: [], settings: [] },
    stems: {
      tracks: [
        {
          name: "aquilo-1",
          layers: [
            { name: "A", files: ["aquilo-1/A/1.opus"] },
            {
              name: "B",
              files: Array.from(
                { length: 4 },
                (_, i) => `aquilo-1/B/${i + 1}.opus`,
              ),
            },
            {
              name: "C",
              files: Array.from(
                { length: 16 },
                (_, i) => `aquilo-1/C/${i + 1}.opus`,
              ),
            },
            {
              name: "D",
              files: Array.from(
                { length: 8 },
                (_, i) => `aquilo-1/D/${i + 1}.opus`,
              ),
            },
          ],
        },
      ],
      recordings: [{ name: "master", file: "piece/master.opus" }],
    },
  };
}

const fixture = mixedManifest();

describe("mixed soundtrack manifest", () => {
  it("reads composed and generative tracks together with their referenced assets", () => {
    const parsed = parseRemoteManifest(mixedManifest());
    expect(parsed.tracks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "composed",
          name: "piece",
          title: "Piece",
          recording: "master",
        }),
        expect.objectContaining({ kind: "generative", name: "aquilo-1" }),
      ]),
    );
    expect(parsed.views.home).toEqual(["piece", "aquilo-1"]);
    expect(parsed.stems).toMatchObject({
      recordings: [{ name: "master", file: "piece/master.opus" }],
    });
  });

  it.each([
    [
      "missing recording",
      (m: typeof fixture) => ({ ...m, stems: { ...m.stems, recordings: [] } }),
    ],
    [
      "duplicate track",
      (m: typeof fixture) => ({ ...m, tracks: [...m.tracks, m.tracks[1]] }),
    ],
    [
      "duplicate recording",
      (m: typeof fixture) => ({
        ...m,
        stems: {
          ...m.stems,
          recordings: [...m.stems.recordings, m.stems.recordings[0]],
        },
      }),
    ],
    [
      "mixed definition",
      (m: typeof fixture) => ({
        ...m,
        tracks: [m.tracks[0], { ...m.tracks[1], layers: AQUILO_1.layers }],
      }),
    ],
  ])("rejects %s atomically", (_label, change) => {
    expect(() => parseRemoteManifest(change(mixedManifest()))).toThrow();
  });
});
