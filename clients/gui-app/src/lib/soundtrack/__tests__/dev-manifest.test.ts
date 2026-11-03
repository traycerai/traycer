/**
 * The development manifest: read from a served `manifest.json`, with the
 * track numbers resolved by name from the repository, and never fetched in a
 * production build. Only the network is faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appLogger } from "@/lib/logger";
import { fetchDevManifest } from "../dev-manifest";
import { readSoundtrackManifest, SOUNDTRACK_MANIFEST } from "../manifest";
import { AQUILO_1 } from "../variable-sound";

const OVERRIDE_KEY = "traycer-soundtrack-dev-manifest-url";

const SERVED = {
  trackNames: ["aquilo-1", "not-a-track-we-know"],
  views: { home: ["aquilo-1"], task: [], bot: [], settings: [] },
  stems: {
    tracks: [{ name: "aquilo-1", layers: [{ name: "A", files: ["A.ogg"] }] }],
  },
};

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
  it("turns the served shape into a manifest with aquilo-1 resolved by name", async () => {
    fetchMock.mockResolvedValue(Response.json(SERVED));

    const manifest = await fetchDevManifest();

    expect(manifest.tracks).toEqual([AQUILO_1]);
    expect(manifest.views).toEqual(SERVED.views);
    expect(manifest.stems).toEqual(SERVED.stems);
    expect(fetchMock).toHaveBeenCalledWith("/__soundtrack-dev/manifest.json");
  });

  it("reads from the url in localStorage when one is set", async () => {
    window.localStorage.setItem(OVERRIDE_KEY, "http://example.test/m.json");
    fetchMock.mockResolvedValue(Response.json(SERVED));

    await fetchDevManifest();

    expect(fetchMock).toHaveBeenCalledWith("http://example.test/m.json");
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

  it("answers the bundled manifest and warns on JSON of the wrong shape", async () => {
    fetchMock.mockResolvedValue(Response.json({ trackNames: "aquilo-1" }));

    await expect(fetchDevManifest()).resolves.toBe(SOUNDTRACK_MANIFEST);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("readSoundtrackManifest", () => {
  it("reads the dev manifest, as a promise, in a development build", async () => {
    vi.stubEnv("MODE", "development");
    fetchMock.mockResolvedValue(Response.json(SERVED));

    const read = readSoundtrackManifest();

    expect(read).toBeInstanceOf(Promise);
    expect((await read).tracks).toEqual([AQUILO_1]);
  });

  it("answers the bundled manifest synchronously, fetching nothing, outside development", () => {
    vi.stubEnv("MODE", "development");
    vi.stubEnv("DEV", false);

    expect(readSoundtrackManifest()).toBe(SOUNDTRACK_MANIFEST);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
