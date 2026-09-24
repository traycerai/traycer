import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The own-identity cache is module state, so every test loads a fresh copy.
async function loadFreshModule() {
  vi.resetModules();
  return import("../process-identity");
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
});

describe("ownProcessStartIdentityAsync", () => {
  it("returns the async probe's identity for this process pid", async () => {
    const mod = await loadFreshModule();
    const reader = vi.fn(async (_pid: number) => "linux:boot-a 4242");
    mod.__setAsyncProcessStartIdentityReaderForTest(reader);

    await expect(mod.ownProcessStartIdentityAsync()).resolves.toBe(
      "linux:boot-a 4242",
    );
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader).toHaveBeenCalledWith(process.pid);
  });

  it("seeds the synchronous cache so the sync read agrees and does not re-probe", async () => {
    const mod = await loadFreshModule();
    const reader = vi.fn(async (_pid: number) => "linux:boot-a 4242");
    mod.__setAsyncProcessStartIdentityReaderForTest(reader);

    await mod.ownProcessStartIdentityAsync();

    // The real synchronous probe would return a different (real) value; the
    // seeded fake proves the cache, not a second probe, answered.
    expect(mod.ownProcessStartIdentity()).toBe("linux:boot-a 4242");
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it("is memoized: two calls run the reader once and share the result", async () => {
    const mod = await loadFreshModule();
    const reader = vi.fn(async (_pid: number) => "linux:boot-a 4242");
    mod.__setAsyncProcessStartIdentityReaderForTest(reader);

    const first = mod.ownProcessStartIdentityAsync();
    const second = mod.ownProcessStartIdentityAsync();
    await expect(first).resolves.toBe("linux:boot-a 4242");
    await expect(second).resolves.toBe("linux:boot-a 4242");
    // A call after settlement is served from the cache as well.
    await expect(mod.ownProcessStartIdentityAsync()).resolves.toBe(
      "linux:boot-a 4242",
    );
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it("resolves null when the probe rejects, and keeps null instead of re-probing", async () => {
    const mod = await loadFreshModule();
    const reader = vi.fn(async (_pid: number): Promise<string | null> => {
      throw new Error("probe failed");
    });
    mod.__setAsyncProcessStartIdentityReaderForTest(reader);

    await expect(mod.ownProcessStartIdentityAsync()).resolves.toBeNull();
    await expect(mod.ownProcessStartIdentityAsync()).resolves.toBeNull();
    expect(mod.ownProcessStartIdentity()).toBeNull();
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it("resolves null when the probe reports no identity", async () => {
    const mod = await loadFreshModule();
    const reader = vi.fn(async (_pid: number): Promise<string | null> => null);
    mod.__setAsyncProcessStartIdentityReaderForTest(reader);

    await expect(mod.ownProcessStartIdentityAsync()).resolves.toBeNull();
    expect(reader).toHaveBeenCalledTimes(1);
  });
});
