/**
 * `prepareDraftImageInlining` directly - the R2 fix. Its contract is stronger
 * than "reconcile the live document": `commit` must run in the SAME
 * synchronous step as the final `readRequiredHashes()` call, or a queued
 * document rewrite can land in the gap and reach the caller's own final read
 * without ever having been attempted (R2(b)). Tested here rather than through
 * a mounted composer where that is cleanest - especially the bound-exhaustion
 * case (c), which needs precise control over pass count.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appLogger } from "@/lib/logger";
import { prepareDraftImageInlining } from "@/lib/drafts/draft-image-inlining";
import { NO_DRAFT_IMAGE_BYTE_TARGET } from "@/lib/drafts/resolve-draft-image-bytes";

const resolveMocks = vi.hoisted(() => ({
  resolveDraftImageBytes: vi.fn<
    (hash: string, target: unknown) => Promise<Uint8Array | null>
  >(() => Promise.resolve(null)),
}));

vi.mock("@/lib/drafts/resolve-draft-image-bytes", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/drafts/resolve-draft-image-bytes")
    >();
  return {
    ...actual,
    resolveDraftImageBytes: resolveMocks.resolveDraftImageBytes,
  };
});

const NOOP_TARGET = NO_DRAFT_IMAGE_BYTE_TARGET;

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const BYTES_A = new Uint8Array([1]);
const BYTES_B = new Uint8Array([2]);

beforeEach(() => {
  resolveMocks.resolveDraftImageBytes.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("prepareDraftImageInlining", () => {
  it("resolves the initial hashes and commits when the live document needs nothing more", async () => {
    resolveMocks.resolveDraftImageBytes.mockImplementation((hash) =>
      hash === HASH_A ? Promise.resolve(BYTES_A) : Promise.resolve(null),
    );
    // Boxed rather than a bare `let`: a bare binding narrows (wrongly) to
    // "always null" across the closure boundary, since the mutation inside
    // `commit` is invisible to control-flow analysis at this call site.
    const captured: { committed: ReadonlyMap<string, string> | null } = {
      committed: null,
    };

    await prepareDraftImageInlining({
      initialHashes: [HASH_A],
      target: NOOP_TARGET,
      readRequiredHashes: () => [],
      commit: (map) => {
        captured.committed = map;
      },
    });

    expect(captured.committed).not.toBeNull();
    if (captured.committed === null) return;
    expect(captured.committed.size).toBe(1);
    expect(captured.committed.has(HASH_A)).toBe(true);
  });

  it("reconciles across several passes: a hash that appears only after resolving the previous one is still resolved", async () => {
    resolveMocks.resolveDraftImageBytes.mockImplementation((hash) => {
      if (hash === HASH_A) return Promise.resolve(BYTES_A);
      if (hash === HASH_B) return Promise.resolve(BYTES_B);
      return Promise.resolve(null);
    });
    // B "appears" only once A has been attempted - modeling a rewrite that
    // landed while A was resolving.
    let requiredCalls = 0;
    const readRequiredHashes = (): ReadonlyArray<string> => {
      requiredCalls += 1;
      return requiredCalls === 1 ? [HASH_B] : [];
    };
    const captured: { committed: ReadonlyMap<string, string> | null } = {
      committed: null,
    };

    await prepareDraftImageInlining({
      initialHashes: [HASH_A],
      target: NOOP_TARGET,
      readRequiredHashes,
      commit: (map) => {
        captured.committed = map;
      },
    });

    expect(captured.committed).not.toBeNull();
    if (captured.committed === null) return;
    expect(captured.committed.has(HASH_A)).toBe(true);
    expect(captured.committed.has(HASH_B)).toBe(true);
    expect(resolveMocks.resolveDraftImageBytes).toHaveBeenCalledWith(
      HASH_B,
      expect.anything(),
    );
  });

  it("(c) at the pass bound: still commits, leaves the never-attempted hash bare, and warns", async () => {
    // EVERY hash resolves to bytes - including the generated ones. With a
    // reader that returned null for late hashes, absence from the committed
    // map was ambiguous: a hash that WAS attempted and simply missed looks
    // identical to one that was never attempted, so the assertion below could
    // not tell the bound from an ordinary miss. Resolving everything makes
    // absence mean exactly one thing.
    resolveMocks.resolveDraftImageBytes.mockImplementation((hash) =>
      hash === HASH_A ? Promise.resolve(BYTES_A) : Promise.resolve(BYTES_B),
    );
    const warnSpy = vi
      .spyOn(appLogger, "warn")
      .mockImplementation(() => undefined);
    // A brand-new, never-before-seen hash every single call: an adversarial
    // or looping producer that never lets the reconcile settle.
    let call = 0;
    let lastYielded = "";
    const readRequiredHashes = (): ReadonlyArray<string> => {
      call += 1;
      lastYielded = `f${call}`.padStart(64, "0");
      return [lastYielded];
    };
    const captured: { committed: ReadonlyMap<string, string> | null } = {
      committed: null,
    };

    await prepareDraftImageInlining({
      initialHashes: [HASH_A],
      target: NOOP_TARGET,
      readRequiredHashes,
      commit: (map) => {
        captured.committed = map;
      },
    });

    // The send still happens - the host's guard is the authority, not this
    // client's own inability to keep up with an adversarial producer.
    expect(captured.committed).not.toBeNull();
    if (captured.committed === null) return;
    expect(captured.committed.has(HASH_A)).toBe(true);
    // The bound is real: `readRequiredHashes` is called once per pass, and
    // the loop runs passes 0..MAX_RECONCILE_PASSES inclusive (that constant is
    // 6 in `draft-image-inlining.ts`) before it gives up - 7 calls total.
    expect(call).toBe(7);
    // The claim in this test's name: the hash yielded by the FINAL read was
    // never attempted, so it is absent from the map and its node travels bare.
    // Both halves matter - absence in the map, AND the resolver never being
    // asked - because with every hash now resolvable, absence can only come
    // from never having been requested.
    expect(lastYielded).not.toBe("");
    expect(captured.committed.has(lastYielded)).toBe(false);
    expect(resolveMocks.resolveDraftImageBytes).not.toHaveBeenCalledWith(
      lastYielded,
      expect.anything(),
    );
    // Positive control on the same reader: every hash it DID attempt resolved,
    // so a 7-entry map is the bound's exact footprint (A plus one per pass).
    expect(captured.committed.size).toBe(7);
    expect(warnSpy).toHaveBeenCalledWith(
      "[draft-image] reconcile bound reached; sending with unattempted images",
      expect.objectContaining({ passes: 7 }),
    );
  });

  it("commit runs in the SAME synchronous step as the final readRequiredHashes call - nothing can land in between", async () => {
    resolveMocks.resolveDraftImageBytes.mockImplementation((hash) =>
      hash === HASH_A ? Promise.resolve(BYTES_A) : Promise.resolve(null),
    );
    // A shared mutable "live document" the way the real callers' editor
    // handle is - `readRequiredHashes` reads it, and a caller's `commit`
    // would re-read it too (exactly what `editor.getJSON()` inside
    // `submitPreparedDraft` does).
    let liveHashes: ReadonlyArray<string> = [];
    let queuedRewriteLanded = false;
    const readRequiredHashes = (): ReadonlyArray<string> => {
      // The instant this read returns "nothing more needed", queue a rewrite
      // that ADDS a new hash-only node - the exact shape of a paste or a
      // queued editor mutation landing right after this check. If `commit`
      // is truly synchronous with this call, this microtask cannot have run
      // by the time the caller's own final document read (inside `commit`)
      // happens.
      void Promise.resolve().then(() => {
        liveHashes = [HASH_C];
        queuedRewriteLanded = true;
      });
      return liveHashes;
    };
    let sentHashes: ReadonlyArray<string> | null = null;

    await prepareDraftImageInlining({
      initialHashes: [HASH_A],
      target: NOOP_TARGET,
      readRequiredHashes,
      commit: () => {
        // The caller's OWN final document read, happening inside `commit` -
        // this is what `submitPreparedDraft`'s `editor.getJSON()` stands in
        // for.
        sentHashes = liveHashes;
      },
    });

    expect(sentHashes).toEqual([]);
    // The rewrite DID eventually land (proving the race was real, not just
    // never scheduled) - it simply could not win it.
    await Promise.resolve();
    expect(queuedRewriteLanded).toBe(true);
    expect(sentHashes).toEqual([]);
  });
});
