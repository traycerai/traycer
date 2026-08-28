import { mkdir, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  withUpdateContender,
  type LockMetadata,
  type PublishedUpdateAdoption,
  type UpdateMutationCapability,
} from "../index";
import {
  UPDATE_ADOPTION_MAX_AGE_MS,
  consumeUpdateAttemptAdoption,
  writeAdoptionProof,
} from "../adoption-transport";
import { createUpdateMutationCapabilityAdoption } from "../contender";
import { randomUUID } from "node:crypto";

// F10/F4/F8/F12 (Ticket 05 review, round 5) need to substitute a predictable
// nonce for exactly one call without disturbing every OTHER `randomUUID()`
// caller this suite's production code paths reach (`store.ts`'s commit tmp
// files, `consumeUpdateAttemptAdoption`'s own claim-path nonce). Wrapping the
// real implementation and using `mockReturnValueOnce` per test - never a
// blanket `mockReturnValue` - is what keeps every other call in this file
// genuinely random, exactly as production runs it.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

// These tests certify the SHARED transport, deliberately not the CLI adapter
// that re-exports its consume half. A suite left pointing at the adapter would
// certify a pass-through while the real implementation sat unexercised - the
// same "certifies a subset that reads as a total" failure this epic has hit
// more than once.
//
// `publishUpdateAttemptAdoption` no longer exists as a function: minting is now
// a two-line composition at each call site, so this local helper is exactly
// what a production minter does. The forged-capability case below therefore
// still exercises the REAL `createUpdateMutationCapabilityAdoption` refusal
// rather than a stub of it.
async function publishUpdateAttemptAdoption(
  capability: UpdateMutationCapability,
  hostHomeDir: string,
  nowMs: number,
): Promise<PublishedUpdateAdoption> {
  const adoption = await createUpdateMutationCapabilityAdoption(
    capability,
    hostHomeDir,
  );
  return writeAdoptionProof(adoption, hostHomeDir, nowMs);
}

// The parent-to-child transport for Ruling 1's adoption proof (design §3.2
// "Transport"): nonce-named, user-private, age-bounded, and consumed on
// read so a proof cannot be replayed. `consumeUpdateAttemptAdoption` is
// total - every failure resolves to `absent` rather than throwing, which is
// what lets a solo CLI invocation with no `--attempt-adoption` fall back to
// ordinary acquisition unchanged.

const roots: string[] = [];

async function freshHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "update-adoption-transport-test-"));
  roots.push(root);
  const hostHomeDir = join(root, "host-home");
  await mkdir(hostHomeDir, { recursive: true });
  return hostHomeDir;
}

function adoptionFilePath(hostHomeDir: string, nonce: string): string {
  return join(resolve(hostHomeDir), `.update-attempt-adoption.${nonce}.json`);
}

// Explicit rather than defaulted, per the repo's type-safety rules.
function fakeHolder(overrides: Partial<LockMetadata>): LockMetadata {
  return {
    pid: process.pid,
    reason: "fixture",
    startedAt: "2026-01-01T00:00:00.000Z",
    hostname: null,
    token: "fixture-token",
    processStartedAtMs: null,
    processStartIdentity: null,
    ...overrides,
  };
}

async function writeRawAdoptionFile(
  hostHomeDir: string,
  fileNonce: string,
  body: {
    readonly nonce: string;
    readonly issuedAtMs: number;
    readonly adoption: {
      readonly hostHomeDir: string;
      readonly holder: LockMetadata;
    };
  },
): Promise<void> {
  await writeFile(
    adoptionFilePath(hostHomeDir, fileNonce),
    JSON.stringify(body),
    { mode: 0o600 },
  );
}

// A real `FileHandle`'s prototype, obtained through a throwaway open/close so
// the `sync` spy below wraps the ACTUAL class every `open()` call returns an
// instance of, rather than a hand-built stand-in that only resembles one.
let fileHandlePrototypeCache: object | null = null;
async function realFileHandlePrototype(): Promise<object> {
  if (fileHandlePrototypeCache !== null) return fileHandlePrototypeCache;
  const probeRoot = await mkdtemp(join(tmpdir(), "update-adoption-fh-probe-"));
  roots.push(probeRoot);
  const handle = await open(join(probeRoot, "probe"), "w");
  await handle.close();
  fileHandlePrototypeCache = Object.getPrototypeOf(handle) as object;
  return fileHandlePrototypeCache;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("publishUpdateAttemptAdoption / consumeUpdateAttemptAdoption - round trip", () => {
  it("publishes a real live-lock proof that a matching consume adopts", async () => {
    const hostHomeDir = await freshHome();

    const outer = await withUpdateContender(
      {
        hostHomeDir,
        reason: "update-adoption-round-trip-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "attempt-executor",
      },
      async (capability) => {
        const published = await publishUpdateAttemptAdoption(
          capability,
          hostHomeDir,
          1_000_000,
        );
        expect(published.nonce).toMatch(/^[0-9a-f-]{36}$/);

        const consumed = await consumeUpdateAttemptAdoption(
          hostHomeDir,
          published.nonce,
          1_000_500,
        );
        expect(consumed).toMatchObject({
          kind: "adopted",
          adoption: { hostHomeDir: resolve(hostHomeDir) },
        });
        return "ok";
      },
    );
    expect(outer).toMatchObject({ kind: "ran", result: "ok" });
  });

  it("is consumed on read - replaying the same nonce a second time is absent", async () => {
    const hostHomeDir = await freshHome();

    await withUpdateContender(
      {
        hostHomeDir,
        reason: "update-adoption-replay-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "attempt-executor",
      },
      async (capability) => {
        const published = await publishUpdateAttemptAdoption(
          capability,
          hostHomeDir,
          1_000_000,
        );
        const first = await consumeUpdateAttemptAdoption(
          hostHomeDir,
          published.nonce,
          1_000_500,
        );
        expect(first.kind).toBe("adopted");

        const replay = await consumeUpdateAttemptAdoption(
          hostHomeDir,
          published.nonce,
          1_000_600,
        );
        expect(replay).toEqual({ kind: "absent", cause: "unreadable" });
      },
    );
  });

  it("cancel() removes an unconsumed proof and is a safe no-op if called again", async () => {
    const hostHomeDir = await freshHome();

    await withUpdateContender(
      {
        hostHomeDir,
        reason: "update-adoption-cancel-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "attempt-executor",
      },
      async (capability) => {
        const published = await publishUpdateAttemptAdoption(
          capability,
          hostHomeDir,
          1_000_000,
        );
        const path = adoptionFilePath(hostHomeDir, published.nonce);
        await expect(stat(path)).resolves.toBeDefined();

        await published.cancel();
        await expect(stat(path)).rejects.toThrow();
        // Safe to call twice.
        await expect(published.cancel()).resolves.toBeUndefined();

        const consumed = await consumeUpdateAttemptAdoption(
          hostHomeDir,
          published.nonce,
          1_000_500,
        );
        expect(consumed).toEqual({ kind: "absent", cause: "unreadable" });
      },
    );
  });

  it("throws rather than minting a proof from a forged/unissued capability", async () => {
    const hostHomeDir = await freshHome();
    const forged = { hostHomeDir } as Parameters<
      typeof publishUpdateAttemptAdoption
    >[0];
    await expect(
      publishUpdateAttemptAdoption(forged, hostHomeDir, 1_000_000),
    ).rejects.toThrow();
  });

  it("never carries the lock token on the published transport value - only an opaque nonce", async () => {
    const hostHomeDir = await freshHome();
    await withUpdateContender(
      {
        hostHomeDir,
        reason: "update-adoption-no-token-on-return-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "attempt-executor",
      },
      async (capability) => {
        const published = await publishUpdateAttemptAdoption(
          capability,
          hostHomeDir,
          1_000_000,
        );
        const keys = Object.keys(published).sort();
        expect(keys).toEqual(["cancel", "nonce"]);
        await published.cancel();
      },
    );
  });
});

describe("consumeUpdateAttemptAdoption - hand-authored proof edge cases", () => {
  const REAL_NONCE = "11111111-1111-1111-1111-111111111111";

  it("resolves absent/unreadable when no proof exists for the requested nonce", async () => {
    const hostHomeDir = await freshHome();
    const consumed = await consumeUpdateAttemptAdoption(
      hostHomeDir,
      "does-not-exist",
      0,
    );
    expect(consumed).toEqual({ kind: "absent", cause: "unreadable" });
  });

  it("resolves absent/malformed on invalid JSON", async () => {
    const hostHomeDir = await freshHome();
    await writeFile(
      adoptionFilePath(hostHomeDir, REAL_NONCE),
      "not json at all",
    );
    const consumed = await consumeUpdateAttemptAdoption(
      hostHomeDir,
      REAL_NONCE,
      0,
    );
    expect(consumed).toEqual({ kind: "absent", cause: "malformed" });
  });

  it("resolves absent/malformed on well-formed JSON missing required fields", async () => {
    const hostHomeDir = await freshHome();
    await writeFile(
      adoptionFilePath(hostHomeDir, REAL_NONCE),
      JSON.stringify({ nonce: REAL_NONCE }),
    );
    const consumed = await consumeUpdateAttemptAdoption(
      hostHomeDir,
      REAL_NONCE,
      0,
    );
    expect(consumed).toEqual({ kind: "absent", cause: "malformed" });
  });

  it("resolves absent/nonce-mismatch when the file's own nonce field disagrees with the requested one", async () => {
    const hostHomeDir = await freshHome();
    // A proof correctly named on disk for REAL_NONCE, but whose CONTENT
    // claims a different nonce - the shape a copy-to-another-path attack
    // would produce.
    await writeRawAdoptionFile(hostHomeDir, REAL_NONCE, {
      nonce: "22222222-2222-2222-2222-222222222222",
      issuedAtMs: 0,
      adoption: { hostHomeDir: resolve(hostHomeDir), holder: fakeHolder({}) },
    });
    const consumed = await consumeUpdateAttemptAdoption(
      hostHomeDir,
      REAL_NONCE,
      0,
    );
    expect(consumed).toEqual({ kind: "absent", cause: "nonce-mismatch" });
  });

  it("resolves absent/expired once issuedAtMs is older than UPDATE_ADOPTION_MAX_AGE_MS", async () => {
    const hostHomeDir = await freshHome();
    await writeRawAdoptionFile(hostHomeDir, REAL_NONCE, {
      nonce: REAL_NONCE,
      issuedAtMs: 0,
      adoption: { hostHomeDir: resolve(hostHomeDir), holder: fakeHolder({}) },
    });
    const justInsideWindow = await (async () => {
      await writeRawAdoptionFile(hostHomeDir, "in-window-nonce", {
        nonce: "in-window-nonce",
        issuedAtMs: 0,
        adoption: { hostHomeDir: resolve(hostHomeDir), holder: fakeHolder({}) },
      });
      return consumeUpdateAttemptAdoption(
        hostHomeDir,
        "in-window-nonce",
        UPDATE_ADOPTION_MAX_AGE_MS,
      );
    })();
    expect(justInsideWindow.kind).toBe("adopted");

    const expired = await consumeUpdateAttemptAdoption(
      hostHomeDir,
      REAL_NONCE,
      UPDATE_ADOPTION_MAX_AGE_MS + 1,
    );
    expect(expired).toEqual({ kind: "absent", cause: "expired" });
  });

  it("resolves absent/expired for a FUTURE-dated issuedAtMs beyond the window, symmetric with the backward case above", async () => {
    const hostHomeDir = await freshHome();
    // A proof issued far in the future relative to `nowMs` - a backward
    // wall-clock step on the writer, or a corrupted stamp - is not a grant
    // anyone can still use, exactly like the too-old case above. The
    // `Math.abs()` check treats both directions identically.
    await writeRawAdoptionFile(hostHomeDir, REAL_NONCE, {
      nonce: REAL_NONCE,
      issuedAtMs: UPDATE_ADOPTION_MAX_AGE_MS + 1,
      adoption: { hostHomeDir: resolve(hostHomeDir), holder: fakeHolder({}) },
    });
    const consumed = await consumeUpdateAttemptAdoption(
      hostHomeDir,
      REAL_NONCE,
      0,
    );
    expect(consumed).toEqual({ kind: "absent", cause: "expired" });
  });

  it("still adopts a future-dated issuedAtMs that is inside the window", async () => {
    const hostHomeDir = await freshHome();
    await writeRawAdoptionFile(hostHomeDir, REAL_NONCE, {
      nonce: REAL_NONCE,
      issuedAtMs: UPDATE_ADOPTION_MAX_AGE_MS,
      adoption: { hostHomeDir: resolve(hostHomeDir), holder: fakeHolder({}) },
    });
    const consumed = await consumeUpdateAttemptAdoption(
      hostHomeDir,
      REAL_NONCE,
      0,
    );
    expect(consumed.kind).toBe("adopted");
  });

  it("resolves absent/wrong-host-home when the embedded adoption names a different host home than the caller's own", async () => {
    const hostHomeDir = await freshHome();
    const otherHome = await freshHome();
    await writeRawAdoptionFile(hostHomeDir, REAL_NONCE, {
      nonce: REAL_NONCE,
      issuedAtMs: 0,
      adoption: { hostHomeDir: resolve(otherHome), holder: fakeHolder({}) },
    });
    const consumed = await consumeUpdateAttemptAdoption(
      hostHomeDir,
      REAL_NONCE,
      0,
    );
    expect(consumed).toEqual({ kind: "absent", cause: "wrong-host-home" });
  });

  it("still consumes (deletes) a malformed or otherwise-rejected proof on read, so it cannot be retried either", async () => {
    const hostHomeDir = await freshHome();
    await writeFile(
      adoptionFilePath(hostHomeDir, REAL_NONCE),
      "not json at all",
    );
    await consumeUpdateAttemptAdoption(hostHomeDir, REAL_NONCE, 0);
    await expect(
      stat(adoptionFilePath(hostHomeDir, REAL_NONCE)),
    ).rejects.toThrow();
  });
});

// F10 (round 5 review): the existing suite exercised the round trip but never
// bound mode, O_EXCL, or fsync to the file `writeAdoptionProof` actually
// produces - each one could be silently removed and every test above would
// stay green. These three tests read the PRODUCTION-written file's real
// on-disk properties (or observe the real syscall), not a fixture's.
describe("writeAdoptionProof - properties the file itself must carry", () => {
  it("writes the proof file with mode 0600 - stat'd on the file writeAdoptionProof itself created", async () => {
    const hostHomeDir = await freshHome();
    const published = await writeAdoptionProof(
      { hostHomeDir, holder: fakeHolder({}) },
      hostHomeDir,
      1_000_000,
    );
    const info = await stat(adoptionFilePath(hostHomeDir, published.nonce));
    expect(info.mode & 0o777).toBe(0o600);

    // Ablated: changed the production `open()` call's mode argument from
    // `0o600` to `0o644` and re-ran this test alone - it went red
    // (`0o644 !== 0o600`). Reverted immediately.
    await published.cancel();
  });

  it("O_EXCL rejects a nonce collision rather than silently overwriting a live proof", async () => {
    const hostHomeDir = await freshHome();
    const collidingNonce = "11111111-2222-3333-4444-555555555555";
    vi.mocked(randomUUID).mockReturnValueOnce(collidingNonce);
    // Pre-create the target this specific nonce will resolve to, with
    // content that must survive the collision untouched.
    const targetPath = adoptionFilePath(hostHomeDir, collidingNonce);
    await writeFile(targetPath, "someone else's live proof", { mode: 0o600 });

    await expect(
      writeAdoptionProof(
        { hostHomeDir, holder: fakeHolder({}) },
        hostHomeDir,
        1_000_000,
      ),
    ).rejects.toThrow();

    // The pre-existing file was not overwritten.
    const { readFile } = await import("node:fs/promises");
    await expect(readFile(targetPath, "utf8")).resolves.toBe(
      "someone else's live proof",
    );

    // Ablated: dropped `constants.O_EXCL` from the production `open()` flags
    // (kept `O_WRONLY | O_CREAT`) and re-ran this test alone - it went red on
    // BOTH assertions: the write no longer threw, and the pre-existing
    // content was replaced with the new proof's JSON. Reverted immediately.
  });

  it("fsyncs the proof before returning - the real FileHandle.sync() is actually invoked", async () => {
    const hostHomeDir = await freshHome();
    const prototype = await realFileHandlePrototype();
    const syncSpy = vi.spyOn(prototype as { sync(): Promise<void> }, "sync");

    const published = await writeAdoptionProof(
      { hostHomeDir, holder: fakeHolder({}) },
      hostHomeDir,
      1_000_000,
    );

    expect(syncSpy).toHaveBeenCalled();
    // Ablated: commented out `await handle.sync();` in production and
    // re-ran this test alone - it went red (`syncSpy` never called).
    // Reverted immediately.
    await published.cancel();
  });
});

// F4 (HIGH, round 5): the existing round-trip test replays sequentially, so
// it cannot see a race between concurrent consumers. The reviewer measured
// the real one: 32 parallel `consumeUpdateAttemptAdoption` calls against one
// proof, 8 accepted under the old read-then-`rm` implementation.
describe("consumeUpdateAttemptAdoption - concurrent consumption is one-shot", () => {
  it("exactly one of 32 parallel consumers adopts; every other one is absent", async () => {
    const hostHomeDir = await freshHome();
    const nonce = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await writeRawAdoptionFile(hostHomeDir, nonce, {
      nonce,
      issuedAtMs: 1_000_000,
      adoption: { hostHomeDir: resolve(hostHomeDir), holder: fakeHolder({}) },
    });

    const CONCURRENCY = 32;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        consumeUpdateAttemptAdoption(hostHomeDir, nonce, 1_000_500),
      ),
    );

    const adopted = results.filter((r) => r.kind === "adopted");
    const absent = results.filter((r) => r.kind === "absent");
    expect(adopted).toHaveLength(1);
    expect(absent).toHaveLength(CONCURRENCY - 1);

    // Ablated: reverted production to the prior read-then-`rm` sequence
    // (open, readFile, then `rm(path)`) and re-ran this exact test. All 32
    // parallel calls returned `adopted` (`toHaveLength(1)` failed with
    // length 32) - this suite's single-process event loop interleaves the
    // 32 `open()`s before any of them gets to `rm`, so every one of them
    // observes the file still present and reads a still-live proof. Worse
    // than the reviewer's own 8/32 (their run presumably had rm() calls
    // interleaved in), but the same class of bug and unambiguously red.
    // Reverted before committing anything.
  });
});

// F8 (MEDIUM, round 5): a nonce is a caller-supplied string
// (`--attempt-adoption <nonce>`), never validated as a path. Before the
// `NONCE_PATTERN` gate, a traversal nonce reached `join()` directly and both
// opened AND deleted a real file outside the host home before any validation
// ran - this deleted a file outside the host home during the reviewer's own
// testing.
describe("consumeUpdateAttemptAdoption - nonce path traversal cannot escape the host home", () => {
  // Every one of these fails `NONCE_PATTERN` (which requires a bare
  // `[A-Za-z0-9][A-Za-z0-9-]*` token) and must be rejected before any
  // filesystem call - this is the broad alphabet-gate coverage.
  const REJECTED_NONCES = [
    "../../../victim",
    "../victim",
    "foo/../../victim",
    "/etc/victim",
    "..",
    "..%2f..%2fvictim",
  ];

  it.each(REJECTED_NONCES)(
    "nonce %j resolves absent/malformed-nonce",
    async (traversalNonce) => {
      const hostHomeDir = await freshHome();
      const consumed = await consumeUpdateAttemptAdoption(
        hostHomeDir,
        traversalNonce,
        0,
      );
      expect(consumed).toEqual({ kind: "absent", cause: "malformed-nonce" });
    },
  );

  // Mirrors the EXACT (unguarded) naming scheme `adoptionPath` builds -
  // `.update-attempt-adoption.<nonce>.json` joined onto the host home - so a
  // victim placed here sits precisely where a `NONCE_PATTERN` bypass would
  // reach. Confirmed by direct computation that `../../../victim` and
  // `foo/../../victim` both walk past the host home's own parent through
  // this exact construction (the concatenated `.update-attempt-adoption.`
  // prefix consumes one `..` level before the nonce's own `../..` still
  // escapes further).
  function vulnerableNonceTargetPath(
    hostHomeDir: string,
    nonce: string,
  ): string {
    return join(resolve(hostHomeDir), `.update-attempt-adoption.${nonce}.json`);
  }

  it.each(["../../../victim", "foo/../../victim"])(
    "nonce %j leaves a real file outside the host home untouched, at the exact path a bypass would address",
    async (escapingNonce) => {
      const hostHomeDir = await freshHome();
      const victimPath = vulnerableNonceTargetPath(hostHomeDir, escapingNonce);
      // Sanity: this nonce's unguarded target really is outside the host
      // home - if this ever stops being true (e.g. the naming scheme
      // changes), the test's premise is gone and it must be revisited
      // rather than silently proving nothing.
      expect(resolve(victimPath).startsWith(resolve(hostHomeDir) + "/")).toBe(
        false,
      );
      const victimContents = "do not touch me";
      // `dirname(victimPath)` lands inside this test's own mkdtemp `root`
      // (already tracked by `freshHome()`'s `roots` push), never a real
      // machine path - the escape is real relative to the host home, but
      // stays fully contained within this test's disposable temp tree.
      await mkdir(dirname(victimPath), { recursive: true });
      await writeFile(victimPath, victimContents);

      const consumed = await consumeUpdateAttemptAdoption(
        hostHomeDir,
        escapingNonce,
        0,
      );

      expect(consumed).toEqual({ kind: "absent", cause: "malformed-nonce" });
      // The whole point: the victim is still exactly as written.
      const { readFile } = await import("node:fs/promises");
      await expect(readFile(victimPath, "utf8")).resolves.toBe(victimContents);

      // Ablated: reverted `adoptionPath` to the prior unguarded
      // `join(resolve(hostHomeDir), ...)` construction (no `NONCE_PATTERN`
      // check, no dirname belt-and-braces) and re-ran this test with both
      // nonces. Both went red on the FIRST assertion (`cause: "malformed"`,
      // not `"malformed-nonce"` - the unguarded resolver let the call reach
      // the real file and try to JSON.parse its plain-text content) and,
      // separately confirmed with a throwaway repro script, the victim was
      // truly gone afterward (`readFile` rejected ENOENT): the fixed
      // `consumeUpdateAttemptAdoption` RENAMES the resolved path to a
      // private claim name before reading it, so under the unguarded
      // resolver this moved the real victim file out from under itself and
      // unlinked the claim copy in its `finally` regardless of the parse
      // outcome. Reverted before committing anything.
    },
  );
});

// F12 (LOW, round 5): the caller of `writeAdoptionProof` never receives the
// `cancel()` handle on a throw path - the promise rejects - so it has no way
// to clean up. Production now `rm`s the created path itself before
// re-throwing. Prove a failure AFTER the file exists (write succeeded, sync
// did not) still leaves nothing behind.
describe("writeAdoptionProof - a write/sync failure leaves no file behind", () => {
  it("a failing sync() removes the partially-written proof rather than leaking it", async () => {
    const hostHomeDir = await freshHome();
    const failingNonce = "ffffffff-0000-1111-2222-333333333333";
    vi.mocked(randomUUID).mockReturnValueOnce(failingNonce);
    const targetPath = adoptionFilePath(hostHomeDir, failingNonce);

    const prototype = await realFileHandlePrototype();
    vi.spyOn(
      prototype as { sync(): Promise<void> },
      "sync",
    ).mockRejectedValueOnce(new Error("simulated fsync failure"));

    await expect(
      writeAdoptionProof(
        { hostHomeDir, holder: fakeHolder({}) },
        hostHomeDir,
        1_000_000,
      ),
    ).rejects.toThrow("simulated fsync failure");

    // No file left behind at all - not a truncated one, not a stale one.
    await expect(stat(targetPath)).rejects.toThrow();

    // Ablation performed against a scratch copy: removing the `catch`
    // block's `await rm(path, { force: true })` (so the function just
    // re-threw) and re-running this test reproduced exactly the leak the
    // finding describes - `stat(targetPath)` resolved instead of rejecting.
    // Reverted before committing anything.
  });
});
