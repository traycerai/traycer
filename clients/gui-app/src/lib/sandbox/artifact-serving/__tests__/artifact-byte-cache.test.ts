// @vitest-environment node
//
// Pure data/logic over the shared span cache, no DOM needed: see
// artifact-server.test.ts for why this stays off jsdom.
import { describe, expect, it, vi } from "vitest";
import { createArtifactByteCache } from "../artifact-byte-cache";
import type {
  ArtifactReadSpan,
  ArtifactReadSpanResult,
} from "../artifact-server";

const MAX_FILE_BYTES = 8 * 1024 * 1024;

function bytesResult(
  length: number,
  totalBytes: number,
): ArtifactReadSpanResult {
  return { bytes: new Uint8Array(length), totalBytes, mediaType: "text/css" };
}

/** A read port that never resolves until the test settles it. */
function deferredRead(): {
  readonly read: ArtifactReadSpan;
  resolve: (result: ArtifactReadSpanResult) => void;
  readonly calls: {
    readonly hash: string;
    readonly offset: number;
    readonly length: number;
    readonly signal: AbortSignal;
  }[];
} {
  const calls: {
    readonly hash: string;
    readonly offset: number;
    readonly length: number;
    readonly signal: AbortSignal;
  }[] = [];
  let resolve: (result: ArtifactReadSpanResult) => void = () => {
    throw new Error("resolve called before a read started");
  };
  const read: ArtifactReadSpan = (hash, offset, length, signal) => {
    calls.push({ hash, offset, length, signal });
    return new Promise((res, rej) => {
      resolve = res;
      // A real read port rejects once its own signal is cancelled; the fake
      // must honor that or clear()'s abort would have nothing to settle.
      signal.addEventListener(
        "abort",
        () => rej(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
  };
  return {
    read,
    resolve: (result) => resolve(result),
    calls,
  };
}

describe("createArtifactByteCache", () => {
  it("serves a repeated span from cache without calling the port again", async () => {
    const read = vi.fn<ArtifactReadSpan>(() =>
      Promise.resolve(bytesResult(10, 10)),
    );
    const { readSpan } = createArtifactByteCache(read);

    const first = await readSpan("sha-1", 0, 10, new AbortController().signal);
    const second = await readSpan("sha-1", 0, 10, new AbortController().signal);

    expect(read).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("keys the cache by hash, offset and length together", async () => {
    // One 20-byte file throughout, so every call is a realistic response
    // (bytes never exceeds totalBytes) while hash, offset and length each
    // vary independently across the four calls.
    const read = vi.fn<ArtifactReadSpan>((_hash, _offset, length) =>
      Promise.resolve(bytesResult(length, 20)),
    );
    const { readSpan } = createArtifactByteCache(read);

    await readSpan("sha-1", 0, 10, new AbortController().signal);
    await readSpan("sha-1", 10, 10, new AbortController().signal); // different offset
    await readSpan("sha-1", 0, 20, new AbortController().signal); // different length
    await readSpan("sha-2", 0, 10, new AbortController().signal); // different hash

    expect(read).toHaveBeenCalledTimes(4);
  });

  it("shares one in-flight read between concurrent callers of the same span", async () => {
    const { read, resolve, calls } = deferredRead();
    const { readSpan } = createArtifactByteCache(read);

    const first = readSpan("sha-1", 0, 10, new AbortController().signal);
    const second = readSpan("sha-1", 0, 10, new AbortController().signal);
    expect(calls).toHaveLength(1);

    resolve(bytesResult(10, 10));
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
  });

  it("does not cancel a shared read when only one of several readers aborts", async () => {
    const { read, resolve, calls } = deferredRead();
    const { readSpan } = createArtifactByteCache(read);
    const abortedController = new AbortController();
    const liveController = new AbortController();

    const aborted = readSpan("sha-1", 0, 10, abortedController.signal);
    const live = readSpan("sha-1", 0, 10, liveController.signal);
    abortedController.abort(new DOMException("cancelled", "AbortError"));

    await expect(aborted).rejects.toThrow();
    expect(calls[0].signal.aborted).toBe(false);

    resolve(bytesResult(10, 10));
    await expect(live).resolves.toEqual(bytesResult(10, 10));
  });

  it("aborts the underlying read once every reader has left", async () => {
    const { read, calls } = deferredRead();
    const { readSpan } = createArtifactByteCache(read);
    const controller = new AbortController();

    const pending = readSpan("sha-1", 0, 10, controller.signal);
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(pending).rejects.toThrow();
    expect(calls[0].signal.aborted).toBe(true);
  });

  it("does not cache an unavailable result", async () => {
    const read = vi
      .fn<ArtifactReadSpan>()
      .mockResolvedValueOnce({ unavailable: "missing" })
      .mockResolvedValueOnce(bytesResult(10, 10));
    const { readSpan } = createArtifactByteCache(read);

    const first = await readSpan("sha-1", 0, 10, new AbortController().signal);
    const second = await readSpan("sha-1", 0, 10, new AbortController().signal);

    expect(first).toEqual({ unavailable: "missing" });
    expect("bytes" in second).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("bypasses the cache for a span whose file is larger than 8MiB", async () => {
    const read = vi.fn<ArtifactReadSpan>(() =>
      Promise.resolve(bytesResult(10, MAX_FILE_BYTES + 1)),
    );
    const { readSpan } = createArtifactByteCache(read);

    await readSpan("sha-1", 0, 10, new AbortController().signal);
    await readSpan("sha-1", 0, 10, new AbortController().signal);

    expect(read).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest entries once the 32MiB budget is exceeded", async () => {
    // Each file sits at the 8MiB cap, so a span from it is still cacheable;
    // four of them exactly fill the 32MiB budget.
    const EIGHT_MIB = 8 * 1024 * 1024;
    const read = vi.fn<ArtifactReadSpan>(() =>
      Promise.resolve(bytesResult(EIGHT_MIB, EIGHT_MIB)),
    );
    const { readSpan } = createArtifactByteCache(read);
    const signal = new AbortController().signal;

    await readSpan("sha-1", 0, EIGHT_MIB, signal);
    await readSpan("sha-2", 0, EIGHT_MIB, signal);
    await readSpan("sha-3", 0, EIGHT_MIB, signal);
    await readSpan("sha-4", 0, EIGHT_MIB, signal);
    expect(read).toHaveBeenCalledTimes(4);

    // A fifth 8MiB entry pushes the cache to 40MiB, so the least recently
    // touched entry (sha-1) must be evicted to admit it.
    await readSpan("sha-5", 0, EIGHT_MIB, signal);
    expect(read).toHaveBeenCalledTimes(5);

    await readSpan("sha-1", 0, EIGHT_MIB, signal);
    expect(read).toHaveBeenCalledTimes(6);
    await readSpan("sha-3", 0, EIGHT_MIB, signal);
    expect(read).toHaveBeenCalledTimes(6);
  });

  it("re-fetches a key after it was evicted for being the least recently touched", async () => {
    const EIGHT_MIB = 8 * 1024 * 1024;
    const read = vi.fn<ArtifactReadSpan>(() =>
      Promise.resolve(bytesResult(EIGHT_MIB, EIGHT_MIB)),
    );
    const { readSpan } = createArtifactByteCache(read);
    const signal = new AbortController().signal;

    await readSpan("sha-1", 0, EIGHT_MIB, signal);
    await readSpan("sha-2", 0, EIGHT_MIB, signal);
    await readSpan("sha-3", 0, EIGHT_MIB, signal);
    await readSpan("sha-4", 0, EIGHT_MIB, signal);
    // Touching sha-1 again moves it to the most-recently-used end, ahead of
    // sha-2, which never gets touched again.
    await readSpan("sha-1", 0, EIGHT_MIB, signal);
    expect(read).toHaveBeenCalledTimes(4);

    await readSpan("sha-5", 0, EIGHT_MIB, signal);
    expect(read).toHaveBeenCalledTimes(5);

    // sha-2 was the least recently touched once sha-1 was touched again, so
    // it is the one evicted, not sha-1.
    await readSpan("sha-1", 0, EIGHT_MIB, signal);
    expect(read).toHaveBeenCalledTimes(5);
    await readSpan("sha-2", 0, EIGHT_MIB, signal);
    expect(read).toHaveBeenCalledTimes(6);
  });

  it("clear empties the cache so a previously served span is re-read", async () => {
    const read = vi.fn<ArtifactReadSpan>(() =>
      Promise.resolve(bytesResult(10, 10)),
    );
    const { readSpan, clear } = createArtifactByteCache(read);

    await readSpan("sha-1", 0, 10, new AbortController().signal);
    clear();
    await readSpan("sha-1", 0, 10, new AbortController().signal);

    expect(read).toHaveBeenCalledTimes(2);
  });

  it("clear aborts every pending read", async () => {
    const { read, calls } = deferredRead();
    const { readSpan, clear } = createArtifactByteCache(read);
    const controller = new AbortController();

    const pending = readSpan("sha-1", 0, 10, controller.signal);
    clear();

    await expect(pending).rejects.toThrow();
    expect(calls[0].signal.aborted).toBe(true);
  });

  // StrictMode mounts, cleans up and remounts a consumer's effect; an owner
  // that clears the shared cache on that teardown must still serve a fresh
  // read correctly on the remount, even though the first read for the key
  // was still in flight when clear() ran.
  it("serves a key cleanly after a StrictMode-style clear while its read was still pending", async () => {
    const { read, resolve, calls } = deferredRead();
    const { readSpan, clear } = createArtifactByteCache(read);

    const stale = readSpan("sha-1", 0, 10, new AbortController().signal);
    clear();
    await expect(stale).rejects.toThrow();

    const fresh = readSpan("sha-1", 0, 10, new AbortController().signal);
    expect(calls).toHaveLength(2);
    resolve(bytesResult(10, 10));
    await expect(fresh).resolves.toEqual(bytesResult(10, 10));

    // The fresh value is now cached on its own, unaffected by the clear.
    await expect(
      readSpan("sha-1", 0, 10, new AbortController().signal),
    ).resolves.toEqual(bytesResult(10, 10));
    expect(calls).toHaveLength(2);
  });
});
