import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Blob as NodeBlob } from "node:buffer";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";

// `Response.blob()` (Node's `undici`) and the fake IndexedDB's real
// `structuredClone` both operate on Node's OWN `Blob` (from `node:buffer`),
// a different class than jsdom's ambient `Blob` global - a blob round-tripped
// through the cache fails `instanceof Blob` (the read-side check in
// `appearance-cache.ts`) against whichever class was in scope. Stubbing the
// global to Node's `Blob` for every test in this file makes every fixture
// `new Blob(...)` and the cache's own `instanceof Blob` check agree.
beforeEach(() => {
  vi.stubGlobal("Blob", NodeBlob);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

type CacheModule = typeof import("../appearance-cache");
async function loadAppearanceCache(): Promise<CacheModule> {
  vi.resetModules();
  installFreshIndexedDb();
  return import("../appearance-cache");
}

function blob(sizeBytes: number, marker: number): Blob {
  const bytes = new Uint8Array(sizeBytes);
  bytes[0] = marker;
  return new Blob([bytes], { type: "image/png" });
}

async function blobMarker(candidate: Blob): Promise<number> {
  return new Uint8Array(await candidate.arrayBuffer())[0];
}

function requireBlob(candidate: Blob | null): Blob {
  if (candidate === null) throw new Error("expected a non-null blob");
  return candidate;
}

describe("appearance-cache: blob storage", () => {
  it("round-trips a global blob", async () => {
    const cache = await loadAppearanceCache();
    await cache.writeAppearanceBlob("appearance/bg.png", blob(1024, 7));

    const stored = await cache.readAppearanceBlob("appearance/bg.png");
    expect(stored).not.toBeNull();
    expect(await blobMarker(requireBlob(stored))).toBe(7);
  });
});

describe("appearance-cache: removal and wipe", () => {
  it("removes a single blob without disturbing others", async () => {
    const cache = await loadAppearanceCache();
    await cache.writeAppearanceBlob("keep.png", blob(1024, 1));
    await cache.writeAppearanceBlob("drop.png", blob(1024, 2));

    await cache.removeAppearanceBlob("drop.png");

    expect(await cache.readAppearanceBlob("drop.png")).toBeNull();
    expect(await cache.readAppearanceBlob("keep.png")).not.toBeNull();
  });

  it("wipes stored blobs and rejects late writes", async () => {
    const cache = await loadAppearanceCache();
    await cache.writeAppearanceBlob("wallpaper", blob(1024, 1));
    await cache.clearAppearanceCache();
    expect(await cache.readAppearanceBlob("wallpaper")).toBeNull();
    await expect(
      cache.writeAppearanceBlob("wallpaper", blob(1024, 2)),
    ).rejects.toThrow(/storage is being cleared/);
  });
});
