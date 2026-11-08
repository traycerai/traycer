/**
 * The development manifest: a served v1 `manifest.json` whose stem paths
 * resolve against the url it was read from, never fetched in a production
 * build. Only the network is faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appLogger } from "@/lib/logger";
import { fetchDevManifest } from "../dev-manifest";
import { readSoundtrackManifest, SOUNDTRACK_MANIFEST } from "../manifest";
import type { VariableTrack } from "../variable-sound";
import { AQUILO_1 } from "./aquilo-1";

const OVERRIDE_KEY = "traycer-soundtrack-dev-manifest-url";

function files(prefix: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `${prefix}/${String(index + 1)}.opus`,
  );
}

const GROUPED: VariableTrack = {
  ...AQUILO_1,
  name: "grouped",
  layers: [
    {
      name: "G",
      groups: [
        { name: "x", variants: 2 },
        { name: "y", variants: 1 },
      ],
      sequence: ["x", "y"],
      role: null,
      sublayers: 1,
      sublayerStartingOffset: null,
      pan: null,
    },
  ],
  states: [
    {
      ...AQUILO_1.states[0],
      layersProperties: [AQUILO_1.states[0].layersProperties[0]],
      numberOfEnabledLayers: [1, 1],
    },
  ],
};

function served() {
  return {
    version: 1,
    tracks: [AQUILO_1, GROUPED],
    views: { home: ["aquilo-1"], task: ["grouped"], bot: [], settings: [] },
    stems: {
      tracks: [
        {
          name: "aquilo-1",
          layers: [
            { name: "A", files: files("aquilo-1/A", 1) },
            { name: "B", files: files("aquilo-1/B", 4) },
            { name: "C", files: files("aquilo-1/C", 16) },
            { name: "D", files: files("aquilo-1/D", 8) },
          ],
        },
        {
          name: "grouped",
          layers: [
            {
              name: "G",
              groups: [
                { name: "x", files: files("grouped/x", 2) },
                { name: "y", files: files("grouped/y", 1) },
              ],
            },
          ],
        },
      ],
    },
  };
}

function absolute(base: string, relative: readonly string[]): string[] {
  return relative.map((file) => new URL(file, base).href);
}

const fetchMock = vi.fn<(url: string) => Promise<Response>>();
const warn = vi.fn<() => void>();

beforeEach(() => {
  window.localStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  warn.mockReset();
  vi.spyOn(appLogger, "warn").mockImplementation(warn);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("fetchDevManifest", () => {
  it("reads the served v1 manifest and resolves every stem against the served url", async () => {
    fetchMock.mockResolvedValue(Response.json(served()));

    const manifest = await fetchDevManifest();

    const base = new URL(
      "/__soundtrack-dev/manifest.json",
      window.location.href,
    ).href;
    expect(fetchMock).toHaveBeenCalledWith("/__soundtrack-dev/manifest.json");
    expect(manifest.tracks).toEqual([
      { ...AQUILO_1, kind: "generative" },
      { ...GROUPED, kind: "generative" },
    ]);
    expect(manifest.views).toEqual(served().views);
    expect(manifest.stems).toEqual({
      tracks: [
        {
          name: "aquilo-1",
          layers: [
            { name: "A", files: absolute(base, files("aquilo-1/A", 1)) },
            { name: "B", files: absolute(base, files("aquilo-1/B", 4)) },
            { name: "C", files: absolute(base, files("aquilo-1/C", 16)) },
            { name: "D", files: absolute(base, files("aquilo-1/D", 8)) },
          ],
        },
        {
          name: "grouped",
          layers: [
            {
              name: "G",
              groups: [
                { name: "x", files: absolute(base, files("grouped/x", 2)) },
                { name: "y", files: absolute(base, files("grouped/y", 1)) },
              ],
            },
          ],
        },
      ],
    });
  });

  it("resolves stems against the url in localStorage when one is set", async () => {
    window.localStorage.setItem(
      OVERRIDE_KEY,
      "http://example.test/sets/team/m.json",
    );
    fetchMock.mockResolvedValue(Response.json(served()));

    const manifest = await fetchDevManifest();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://example.test/sets/team/m.json",
    );
    const [aquilo, grouped] = manifest.stems.tracks;
    expect(aquilo.layers[0].files).toEqual([
      "http://example.test/sets/team/aquilo-1/A/1.opus",
    ]);
    expect(grouped.layers[0].groups?.[1].files).toEqual([
      "http://example.test/sets/team/grouped/y/1.opus",
    ]);
  });

  it("answers the bundled manifest and warns when the fetch fails", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));

    await expect(fetchDevManifest()).resolves.toBe(SOUNDTRACK_MANIFEST);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("answers the bundled manifest and warns on a bad status", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 404 }));

    await expect(fetchDevManifest()).resolves.toBe(SOUNDTRACK_MANIFEST);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("answers the bundled manifest and warns on bad JSON", async () => {
    fetchMock.mockResolvedValue(new Response("{not json"));

    await expect(fetchDevManifest()).resolves.toBe(SOUNDTRACK_MANIFEST);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("answers the bundled manifest and warns on a manifest the engine cannot play", async () => {
    fetchMock.mockResolvedValue(Response.json({ ...served(), version: 2 }));

    await expect(fetchDevManifest()).resolves.toBe(SOUNDTRACK_MANIFEST);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("readSoundtrackManifest", () => {
  it("reads the dev manifest, as a promise, in a development build", async () => {
    vi.stubEnv("MODE", "development");
    fetchMock.mockResolvedValue(Response.json(served()));

    const read = readSoundtrackManifest();

    expect(read).toBeInstanceOf(Promise);
    expect((await read).tracks).toEqual([
      { ...AQUILO_1, kind: "generative" },
      { ...GROUPED, kind: "generative" },
    ]);
  });
});
