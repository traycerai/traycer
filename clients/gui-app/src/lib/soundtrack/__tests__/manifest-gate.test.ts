/**
 * What a build offers and where its manifest comes from, through the real gate
 * and the real desktop set reader. Only the preload bridge on `runnerHost` is
 * faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appLogger } from "@/lib/logger";
import { queryClient } from "@/lib/query-client";
import { soundtrackQueryKeys } from "@/lib/query-keys";
import {
  readSoundtrackManifest,
  reissueStemManifest,
  SOUNDTRACK_MANIFEST,
  soundtrackOffered,
} from "../manifest";
import { AQUILO_1 } from "./aquilo-1";

type SetResult =
  | { readonly kind: "ok"; readonly manifest: unknown }
  | { readonly kind: "unavailable" };

function signed(prefix: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) =>
      `https://storage.googleapis.com/bucket/${prefix}/${String(index + 1)}.opus?X-Goog-Signature=abc123`,
  );
}

function setWithCFiles(cFiles: number) {
  return {
    version: 1,
    tracks: [AQUILO_1],
    views: { home: ["aquilo-1"], task: [], bot: [], settings: [] },
    stems: {
      tracks: [
        {
          name: "aquilo-1",
          layers: [
            { name: "A", files: signed("A", 1) },
            { name: "B", files: signed("B", 4) },
            { name: "C", files: signed("C", cFiles) },
            { name: "D", files: signed("D", 8) },
          ],
        },
      ],
    },
  };
}

const readSoundtrackSet = vi.fn<() => Promise<SetResult>>();
const warn = vi.fn<(message: string, fields: unknown) => void>();
const SOUNDTRACK_WARNING = "[soundtrack] could not read the team's track set";
let hadHost = false;
let originalHost: unknown;

function installBridge(available: boolean): void {
  Reflect.set(globalThis, "runnerHost", {
    soundtrackSourceAvailable: available,
    readSoundtrackSet,
  });
}

function soundtrackWarnings(): number {
  return warn.mock.calls.filter(([message]) => message === SOUNDTRACK_WARNING)
    .length;
}

beforeEach(() => {
  hadHost = Reflect.has(globalThis, "runnerHost");
  originalHost = Reflect.get(globalThis, "runnerHost");
  Reflect.deleteProperty(globalThis, "runnerHost");
  readSoundtrackSet.mockReset();
  warn.mockReset();
  queryClient.clear();
  vi.spyOn(appLogger, "warn").mockImplementation(warn);
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, "runnerHost");
  if (hadHost) Reflect.set(globalThis, "runnerHost", originalHost);
  vi.restoreAllMocks();
});

describe("soundtrackOffered", () => {
  it("is false with no bridge", () => {
    expect(soundtrackOffered()).toBe(false);
  });

  it("is false when the bridge reports no source", () => {
    installBridge(false);

    expect(soundtrackOffered()).toBe(false);
  });

  it("is true when the bridge reports a source", () => {
    installBridge(true);

    expect(soundtrackOffered()).toBe(true);
  });
});

describe("readSoundtrackManifest", () => {
  it("answers the bundled manifest synchronously with no bridge", () => {
    expect(readSoundtrackManifest()).toBe(SOUNDTRACK_MANIFEST);
  });

  it("asks the bridge and parses what it answers", async () => {
    installBridge(true);
    readSoundtrackSet.mockResolvedValue({
      kind: "ok",
      manifest: setWithCFiles(16),
    });

    const manifest = await readSoundtrackManifest();

    expect(manifest.tracks).toEqual([AQUILO_1]);
    expect(manifest.stems.tracks[0].layers[0].files).toEqual(signed("A", 1));
  });

  it("falls back to the bundled manifest when the source is unavailable", async () => {
    installBridge(true);
    readSoundtrackSet.mockResolvedValue({ kind: "unavailable" });

    await expect(readSoundtrackManifest()).resolves.toBe(SOUNDTRACK_MANIFEST);
  });

  it("falls back to the bundled manifest and warns when the invoke rejects", async () => {
    installBridge(true);
    readSoundtrackSet.mockRejectedValue(new Error("ipc closed"));

    await expect(readSoundtrackManifest()).resolves.toBe(SOUNDTRACK_MANIFEST);
    expect(soundtrackWarnings()).toBe(1);
    expect(readSoundtrackSet).toHaveBeenCalledTimes(1);
  });

  it("falls back to the bundled manifest on an invalid manifest and logs no signed url", async () => {
    installBridge(true);
    readSoundtrackSet.mockResolvedValue({
      kind: "ok",
      manifest: setWithCFiles(15),
    });

    await expect(readSoundtrackManifest()).resolves.toBe(SOUNDTRACK_MANIFEST);
    expect(soundtrackWarnings()).toBe(1);
    expect(readSoundtrackSet).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("15 stem files for 16 variants");
    expect(logged).not.toContain("X-Goog-Signature");
  });
});

describe("reissueStemManifest", () => {
  it("answers the fresh stems", async () => {
    installBridge(true);
    readSoundtrackSet.mockResolvedValue({
      kind: "ok",
      manifest: setWithCFiles(16),
    });

    await expect(reissueStemManifest()).resolves.toEqual(
      setWithCFiles(16).stems,
    );
  });

  it("answers null with no bridge", async () => {
    await expect(reissueStemManifest()).resolves.toBeNull();
  });

  it("answers null when the bridge has no set to give", async () => {
    installBridge(true);
    readSoundtrackSet.mockResolvedValue({ kind: "unavailable" });

    await expect(reissueStemManifest()).resolves.toBeNull();
  });
});

describe("reading through the query client", () => {
  /** The same stems, each link signed for the read that answers them. */
  function signedFor(read: string): SetResult {
    const links = JSON.stringify(setWithCFiles(16)).replaceAll("abc123", read);
    const manifest: unknown = JSON.parse(links);
    return { kind: "ok", manifest };
  }

  it("calls the bridge once for reads that overlap, and answers both", async () => {
    installBridge(true);
    let release: (result: SetResult) => void = () => {};
    readSoundtrackSet.mockReturnValue(
      new Promise<SetResult>((resolve) => {
        release = resolve;
      }),
    );

    const manifest = readSoundtrackManifest();
    const stems = reissueStemManifest();
    release({ kind: "ok", manifest: setWithCFiles(16) });

    expect((await manifest).stems).toEqual(setWithCFiles(16).stems);
    await expect(stems).resolves.toEqual(setWithCFiles(16).stems);
    expect(readSoundtrackSet).toHaveBeenCalledTimes(1);
  });

  it("makes a real read of each one that follows, answering what that read returned", async () => {
    installBridge(true);
    readSoundtrackSet
      .mockResolvedValueOnce(signedFor("first"))
      .mockResolvedValueOnce(signedFor("second"));

    const first = await readSoundtrackManifest();
    const second = await reissueStemManifest();

    expect(readSoundtrackSet).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(first.stems)).toContain("X-Goog-Signature=first");
    expect(JSON.stringify(second)).toContain("X-Goog-Signature=second");
    expect(JSON.stringify(second)).not.toContain("X-Goog-Signature=first");
  });

  it("keeps no signed link in the cache once a read has settled", async () => {
    vi.useFakeTimers();
    installBridge(true);
    readSoundtrackSet.mockResolvedValue(signedFor("abc123"));

    await readSoundtrackManifest();
    await vi.advanceTimersByTimeAsync(1);

    expect(
      queryClient
        .getQueryCache()
        .find({ queryKey: soundtrackQueryKeys.teamSet() }),
    ).toBeUndefined();
  });
});
