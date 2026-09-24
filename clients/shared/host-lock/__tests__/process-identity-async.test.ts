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
  vi.useRealTimers();
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

  // S2: while one probe is in flight, concurrent callers share it rather than
  // each starting their own - and once it settles, later calls are served
  // from the cache instead of a fresh probe.
  it("S2: concurrent calls while a probe is in flight share one reader call and the same answer", async () => {
    const mod = await loadFreshModule();
    const reader = vi.fn(async (_pid: number) => "linux:boot-a 4242");
    mod.__setAsyncProcessStartIdentityReaderForTest(reader);

    const first = mod.ownProcessStartIdentityAsync();
    const second = mod.ownProcessStartIdentityAsync();
    // Both calls were made before either had a chance to await the reader,
    // so this is the in-flight-sharing path, not two independent probes.
    expect(reader).toHaveBeenCalledTimes(1);
    await expect(first).resolves.toBe("linux:boot-a 4242");
    await expect(second).resolves.toBe("linux:boot-a 4242");
    // A call after settlement is served from the cache as well.
    await expect(mod.ownProcessStartIdentityAsync()).resolves.toBe(
      "linux:boot-a 4242",
    );
    expect(reader).toHaveBeenCalledTimes(1);
  });

  // S1: a failed probe is remembered only for the retry window - within it,
  // repeated calls are answered from memory with no new probe; past it, the
  // next call probes again, and a stamp it finds is cached for good.
  it("S1: a null answer is remembered for the retry window, then probed again and cached", async () => {
    vi.useFakeTimers();
    try {
      const mod = await loadFreshModule();
      const reader = vi.fn(
        async (_pid: number): Promise<string | null> => null,
      );
      mod.__setAsyncProcessStartIdentityReaderForTest(reader);

      await expect(mod.ownProcessStartIdentityAsync()).resolves.toBeNull();
      expect(reader).toHaveBeenCalledTimes(1);

      // Still within the window: answered from memory, no new probe.
      await vi.advanceTimersByTimeAsync(mod.OWN_START_IDENTITY_RETRY_MS - 1);
      await expect(mod.ownProcessStartIdentityAsync()).resolves.toBeNull();
      expect(reader).toHaveBeenCalledTimes(1);

      // Past the window: probes again, and this time it succeeds.
      reader.mockImplementation(async (_pid: number) => "linux:boot-a 4242");
      await vi.advanceTimersByTimeAsync(2);
      await expect(mod.ownProcessStartIdentityAsync()).resolves.toBe(
        "linux:boot-a 4242",
      );
      expect(reader).toHaveBeenCalledTimes(2);

      // Once cached, later calls never call the reader again, however long
      // afterwards they run.
      await vi.advanceTimersByTimeAsync(mod.OWN_START_IDENTITY_RETRY_MS * 5);
      await expect(mod.ownProcessStartIdentityAsync()).resolves.toBe(
        "linux:boot-a 4242",
      );
      expect(reader).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // S3: a REJECTING probe must settle to null rather than throwing out of
  // `ownProcessStartIdentityAsync`, and is retried on the same window as an
  // ordinary null answer - the old contract cached the rejection's null
  // forever, which is exactly F-WIN-2 (a single timed-out probe on a loaded
  // machine costing the desktop its presence record for the process's whole
  // life).
  it("S3: a rejecting probe settles null instead of throwing, and is retried after the window", async () => {
    vi.useFakeTimers();
    try {
      const mod = await loadFreshModule();
      const reader = vi.fn(async (_pid: number): Promise<string | null> => {
        throw new Error("probe failed");
      });
      mod.__setAsyncProcessStartIdentityReaderForTest(reader);

      await expect(mod.ownProcessStartIdentityAsync()).resolves.toBeNull();
      expect(reader).toHaveBeenCalledTimes(1);

      // Within the window, still no new probe - even though the first one
      // rejected rather than resolving null.
      await vi.advanceTimersByTimeAsync(mod.OWN_START_IDENTITY_RETRY_MS - 1);
      await expect(mod.ownProcessStartIdentityAsync()).resolves.toBeNull();
      expect(reader).toHaveBeenCalledTimes(1);

      reader.mockImplementation(async (_pid: number) => "linux:boot-a 7777");
      await vi.advanceTimersByTimeAsync(2);
      await expect(mod.ownProcessStartIdentityAsync()).resolves.toBe(
        "linux:boot-a 7777",
      );
      expect(reader).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // S4: once a stamp is cached, it is final - a reader rigged to answer
  // something else afterwards is never even consulted, from either read.
  it("S4: a cached stamp is never replaced, and neither reader is consulted again", async () => {
    const mod = await loadFreshModule();
    const asyncReader = vi.fn(async (_pid: number) => "linux:boot-a 1111");
    mod.__setAsyncProcessStartIdentityReaderForTest(asyncReader);

    await expect(mod.ownProcessStartIdentityAsync()).resolves.toBe(
      "linux:boot-a 1111",
    );
    expect(asyncReader).toHaveBeenCalledTimes(1);

    // Rig both readers to a DIFFERENT stamp Y; it must never be consulted,
    // and the cached stamp X must never change.
    const syncReader = vi.fn((_pid: number) => "linux:boot-b 2222");
    mod.__setProcessStartIdentityReaderForTest(syncReader);
    asyncReader.mockImplementation(async (_pid: number) => "linux:boot-b 2222");

    expect(mod.ownProcessStartIdentity()).toBe("linux:boot-a 1111");
    await expect(mod.ownProcessStartIdentityAsync()).resolves.toBe(
      "linux:boot-a 1111",
    );
    expect(syncReader).not.toHaveBeenCalled();
    expect(asyncReader).toHaveBeenCalledTimes(1);
  });
});

describe("ownProcessStartIdentity (sync)", () => {
  // S5: the sync read probes at most once per process, ever - even a null
  // answer is not retried past the async retry window, because the sync
  // probe's cost (a blocking PowerShell spawn) is exactly what the async
  // read exists to avoid paying more than once. A stamp the async read finds
  // afterwards still reaches it, since both reads share one cache.
  it("S5: a null sync probe is never retried by the sync reader, but a later async success reaches it", async () => {
    vi.useFakeTimers();
    try {
      const mod = await loadFreshModule();
      const syncReader = vi.fn((_pid: number): string | null => null);
      mod.__setProcessStartIdentityReaderForTest(syncReader);

      expect(mod.ownProcessStartIdentity()).toBeNull();
      expect(syncReader).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(
        mod.OWN_START_IDENTITY_RETRY_MS + 1_000,
      );
      expect(mod.ownProcessStartIdentity()).toBeNull();
      expect(syncReader).toHaveBeenCalledTimes(1);

      const asyncReader = vi.fn(async (_pid: number) => "linux:boot-a 5555");
      mod.__setAsyncProcessStartIdentityReaderForTest(asyncReader);
      await expect(mod.ownProcessStartIdentityAsync()).resolves.toBe(
        "linux:boot-a 5555",
      );

      expect(mod.ownProcessStartIdentity()).toBe("linux:boot-a 5555");
      expect(syncReader).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// S6: on win32, this process's OWN async probe gets three times the room a
// probe of any other pid gets (see `OWN_WINDOWS_START_IDENTITY_TIMEOUT_MS`'s
// comment in `process-identity.ts` for the measured BelowNormal-priority
// numbers behind the 15s figure). Exercised through the DEFAULT reader (the
// seam restored to `null`), with `node:child_process`'s `execFile` mocked to
// capture the `timeout` option it was called with, since that is the one
// thing the reader seam cannot observe.
describe("S6: win32 own-pid async timeout", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    vi.doUnmock("node:child_process");
  });

  it("uses 15000ms for process.pid and 5000ms for a foreign pid", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });

    const FOREIGN_PID = 54_321;
    const powershellTimeouts: number[] = [];

    vi.doMock("node:child_process", () => ({
      execFile: (
        command: string,
        _args: readonly string[],
        options: { readonly timeout?: number },
        callback: (error: Error | null, stdout: string) => void,
      ) => {
        if (command === "tasklist") {
          // Positive liveness for FOREIGN_PID, so the identity probe this
          // test cares about is actually reached.
          callback(null, `"pwsh.exe","${FOREIGN_PID}","Console","1","1 K"`);
          return;
        }
        powershellTimeouts.push(options.timeout ?? -1);
        callback(new Error("no real powershell in test"), "");
      },
      execFileSync: vi.fn(),
    }));

    const mod = await loadFreshModule();
    // Explicit: exercise the DEFAULT reader, not a seam left over from a
    // previous test.
    mod.__setAsyncProcessStartIdentityReaderForTest(null);
    mod.__setAsyncProcessLivenessReaderForTest(null);

    await mod.ownProcessStartIdentityAsync();
    await mod.getPublishedProcessIdentityVerdict(FOREIGN_PID, "win32:stamp");

    expect(powershellTimeouts).toEqual([15_000, 5_000]);
  });
});
