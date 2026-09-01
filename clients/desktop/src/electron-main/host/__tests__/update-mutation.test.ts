import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

const loginItemMocks = vi.hoisted(() => ({
  register: vi.fn(),
  unregister: vi.fn(),
  retire: vi.fn(),
}));

vi.mock("../../app/host-login-item", () => ({
  registerHostLoginItem: loginItemMocks.register,
  unregisterHostLoginItemGuarded: loginItemMocks.unregister,
  retireCompetingCliRegistrationAtLaunchGuarded: loginItemMocks.retire,
}));

// Seam for the tombstone-flush findings (2 + 6): only `open()`/`rm()` calls
// whose path contains `.stop-intent.` are intercepted, and only while
// `tombstoneHook.behavior` is set - every other `open`/`rm`/`rename`/`mkdir`
// call in this file (including the real fixture setup below) passes
// straight through to the real `node:fs/promises`.
//
// `close` deliberately awaits the most recent `sync()` promise before
// resolving, mirroring Node's documented `FileHandle.close()` contract (it
// waits for pending operations on the handle). That coupling is what makes
// the ablation for finding 2 meaningful: with the fix, the deadline arm
// detaches the close (`void handle.close()`), so nothing here is ever
// awaited by the production code and the wrapper's `close` promise is left
// pending harmlessly; if the deadline arm were changed back to `await
// handle.close()`, this wrapper's `close` would transitively await the
// never-settling `sync()` below, hanging exactly as the real filesystem
// contract would.
//
// `log` and `lastClosePromise` exist so a test can make POSITIVE
// observations (an event actually happened, in a known order, on a promise
// it can directly await) instead of an absence claim ("nothing bad
// happened") - an absence claim would pass just as green if the seam were
// never reached at all.
const tombstoneHook = vi.hoisted(() => ({
  behavior: null as null | (() => Promise<void>),
  log: [] as string[],
  lastClosePromise: null as Promise<void> | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  // Explicit `| undefined` rather than `flags?:` / `mode?:` - this repo's
  // lint bans optional parameters, in tests as well as production, and the
  // seam must pass the same gate as the code it wraps.
  const wrappedOpen = async (
    path: Parameters<typeof actual.open>[0],
    flags: Parameters<typeof actual.open>[1] | undefined,
    mode: Parameters<typeof actual.open>[2] | undefined,
  ) => {
    const handle = await actual.open(path, flags, mode);
    if (
      typeof path !== "string" ||
      !path.includes(".stop-intent.") ||
      tombstoneHook.behavior === null
    ) {
      return handle;
    }
    const behavior = tombstoneHook.behavior;
    let pendingSync: Promise<void> | null = null;
    return {
      writeFile: (data: string, encoding: BufferEncoding) =>
        handle.writeFile(data, encoding),
      sync: () => {
        const flush = behavior();
        pendingSync = flush.catch(() => undefined);
        return flush;
      },
      close: () => {
        const settlement = (async () => {
          if (pendingSync !== null) await pendingSync;
          await handle.close();
          tombstoneHook.log.push("close-settled");
        })();
        tombstoneHook.lastClosePromise = settlement;
        return settlement;
      },
    };
  };
  const wrappedRm = async (
    path: Parameters<typeof actual.rm>[0],
    opts: Parameters<typeof actual.rm>[1],
  ) => {
    const result = await actual.rm(path, opts);
    if (typeof path === "string" && path.includes(".stop-intent.")) {
      tombstoneHook.log.push("rm-settled");
    }
    return result;
  };
  const mocked = { ...actual, open: wrappedOpen, rm: wrappedRm };
  return { ...mocked, default: mocked };
});

import {
  consumeUpdateAttemptAdoption,
  updateAttemptLockPath,
  withUpdateContender,
  type UpdateMutationCapability,
} from "@traycer-clients/shared/host-update";
import { hostStopIntentPath } from "@traycer/protocol/config/host-stop-intent";
import {
  DesktopAttemptCapabilityError,
  publishRestartTombstoneWithAttempt,
  registerHostLoginItemWithAttempt,
  unregisterHostLoginItemWithAttempt,
  withMintedAdoption,
} from "../update-mutation";
import type { HostFsLayout } from "../host-paths";
import { freshHostFsLayout } from "./host-fs-layout-test-support";

const roots: string[] = [];

async function freshHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "desktop-final-actuator-test-"));
  roots.push(root);
  return join(root, "host-home");
}

/**
 * `withMintedAdoption` needs a full `HostFsLayout`, not just a `hostHomeDir`
 * string — mirrors the sibling `update-mutation-capability-edges.test.ts`
 * fixture.
 */
function freshLayout(): Promise<HostFsLayout> {
  return freshHostFsLayout(roots, "desktop-minted-adoption-test-");
}

/** Every proof file this module ever writes is named under this prefix. */
async function adoptionFiles(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir).catch(() => [] as string[]);
  return entries.filter((name) => name.startsWith(".update-attempt-adoption"));
}

/** Every scratch file the tombstone publish ever writes is named under this prefix. */
async function stopIntentTempFiles(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir).catch(() => [] as string[]);
  return entries.filter((name) => name.startsWith(".stop-intent."));
}

afterEach(async () => {
  loginItemMocks.register.mockReset();
  loginItemMocks.unregister.mockReset();
  loginItemMocks.retire.mockReset();
  tombstoneHook.behavior = null;
  tombstoneHook.log = [];
  tombstoneHook.lastClosePromise = null;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Desktop guarded final actuators", () => {
  it("refuses registration completion when the verifier is lost between composite steps", async () => {
    const hostHomeDir = await freshHome();
    const lockPath = join(hostHomeDir, "cli-lock");
    await mkdir(hostHomeDir, { recursive: true });
    let callback: (() => Promise<boolean>) | undefined;
    loginItemMocks.register.mockImplementation(
      async (revalidate: () => Promise<boolean>) => {
        callback = revalidate;
        expect(await revalidate()).toBe(true);
        await unlink(updateAttemptLockPath(hostHomeDir));
        expect(await revalidate()).toBe(false);
        return "enabled";
      },
    );

    const outcome = await withUpdateContender(
      {
        hostHomeDir,
        reason: "desktop-register-final-actuator-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "desktop-activation-maintenance",
      },
      async (capability) => {
        await expect(
          registerHostLoginItemWithAttempt(
            capability,
            hostHomeDir,
            async () => true,
          ),
        ).rejects.toMatchObject({
          verdict: "lost",
        });
        return "must-not-report-ran";
      },
    );

    expect(callback).toBeTypeOf("function");
    expect(outcome).toMatchObject({
      kind: "lock-not-live",
      verdict: { kind: "lost" },
    });
  });

  it("refuses unregistration when the verifier is lost between bootout and unregister steps", async () => {
    const hostHomeDir = await freshHome();
    await mkdir(hostHomeDir, { recursive: true });
    loginItemMocks.unregister.mockImplementation(
      async (revalidate: () => Promise<boolean>) => {
        expect(await revalidate()).toBe(true);
        await unlink(updateAttemptLockPath(hostHomeDir));
        expect(await revalidate()).toBe(false);
        return true;
      },
    );

    const outcome = await withUpdateContender(
      {
        hostHomeDir,
        reason: "desktop-unregister-final-actuator-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "uninstall-maintenance",
      },
      async (capability) => {
        await expect(
          unregisterHostLoginItemWithAttempt(capability, hostHomeDir),
        ).rejects.toMatchObject({
          verdict: "lost",
        });
        return "must-not-report-ran";
      },
    );

    expect(outcome).toMatchObject({
      kind: "lock-not-live",
      verdict: { kind: "lost" },
    });
  });

  it("does not accept a forged capability for a guarded Desktop actuator", async () => {
    const hostHomeDir = await freshHome();
    const forged = { hostHomeDir } as UpdateMutationCapability;
    await expect(
      unregisterHostLoginItemWithAttempt(forged, hostHomeDir),
    ).rejects.toMatchObject({ verdict: "not-issued" });
    expect(loginItemMocks.unregister).not.toHaveBeenCalled();
  });
});

describe("withMintedAdoption", () => {
  it("seam: freshLayout resolves under a real temp dir, never the real host home", async () => {
    const layout = await freshLayout();
    expect(layout.rootDir.length).toBeGreaterThan(0);
    expect(layout.rootDir).not.toBe(process.cwd());
    expect(layout.rootDir).not.toBe("");
    const [realRoot, realTmp] = await Promise.all([
      realpath(layout.rootDir),
      realpath(tmpdir()),
    ]);
    expect(realRoot.startsWith(realTmp)).toBe(true);
  });

  it("calls run with exactly [--attempt-adoption, <nonce>] and cancels the proof once run resolves", async () => {
    const layout = await freshLayout();
    let capturedArgs: readonly string[] | undefined;

    const outcome = await withUpdateContender(
      {
        hostHomeDir: layout.rootDir,
        reason: "minted-adoption-argv-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "desktop-activation-maintenance",
      },
      async (capability) =>
        withMintedAdoption(capability, layout, async (args) => {
          capturedArgs = args;
          // The proof must exist WHILE run is executing - this is the whole
          // point of minting before invoking run.
          expect(await adoptionFiles(layout.rootDir)).toHaveLength(1);
          return "run-result";
        }),
    );

    expect(outcome).toMatchObject({ kind: "ran", result: "run-result" });
    expect(capturedArgs).toHaveLength(2);
    expect(capturedArgs?.[0]).toBe("--attempt-adoption");
    const nonce = capturedArgs?.[1] ?? "";
    expect(typeof nonce).toBe("string");
    expect(nonce.length).toBeGreaterThan(0);

    // cancel() ran in `finally`, so nothing is left behind after return.
    expect(await adoptionFiles(layout.rootDir)).toHaveLength(0);
  });

  it("cancels the proof and re-throws the same error when run throws", async () => {
    const layout = await freshLayout();
    const boom = new Error("run blew up");
    let thrown: unknown;

    const outcome = await withUpdateContender(
      {
        hostHomeDir: layout.rootDir,
        reason: "minted-adoption-throw-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "desktop-activation-maintenance",
      },
      async (capability) => {
        try {
          await withMintedAdoption(capability, layout, async () => {
            expect(await adoptionFiles(layout.rootDir)).toHaveLength(1);
            throw boom;
          });
        } catch (err) {
          thrown = err;
        }
        return "handled";
      },
    );

    expect(outcome).toMatchObject({ kind: "ran", result: "handled" });
    // The exact same error object propagates - cancel() must not swallow or
    // replace it.
    expect(thrown).toBe(boom);
    expect(await adoptionFiles(layout.rootDir)).toHaveLength(0);
  });

  it("mints a proof consumed exactly once by the real consumer, matching hostHomeDir and holder", async () => {
    const layout = await freshLayout();
    let firstAdoptedHostHomeDir: string | undefined;
    let firstAdoptedHolderPid: number | undefined;

    const outcome = await withUpdateContender(
      {
        hostHomeDir: layout.rootDir,
        reason: "minted-adoption-consume-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "desktop-activation-maintenance",
      },
      async (capability) =>
        withMintedAdoption(capability, layout, async (args) => {
          const nonce = args[1] ?? "";
          expect(nonce.length).toBeGreaterThan(0);

          const first = await consumeUpdateAttemptAdoption(
            layout.rootDir,
            nonce,
            Date.now(),
          );
          expect(first.kind).toBe("adopted");
          if (first.kind === "adopted") {
            firstAdoptedHostHomeDir = first.adoption.hostHomeDir;
            firstAdoptedHolderPid = first.adoption.holder.pid;
          }

          // Consumed on read: a second read of the SAME nonce finds nothing,
          // because the file is deleted before validation even runs.
          const second = await consumeUpdateAttemptAdoption(
            layout.rootDir,
            nonce,
            Date.now(),
          );
          expect(second).toMatchObject({
            kind: "absent",
            cause: "unreadable",
          });

          return "consumed";
        }),
    );

    expect(outcome).toMatchObject({ kind: "ran", result: "consumed" });
    expect(firstAdoptedHostHomeDir).toBe(layout.rootDir);
    expect(firstAdoptedHolderPid).toBe(process.pid);
    // Already consumed inside `run`; `cancel()` in `finally` is a safe
    // double-remove and must not resurrect or error on a missing file.
    expect(await adoptionFiles(layout.rootDir)).toHaveLength(0);
  });

  it("cleans up an unconsumed proof after run returns without ever reading it", async () => {
    const layout = await freshLayout();

    const outcome = await withUpdateContender(
      {
        hostHomeDir: layout.rootDir,
        reason: "minted-adoption-unconsumed-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "desktop-activation-maintenance",
      },
      async (capability) =>
        withMintedAdoption(capability, layout, async () => {
          // Simulates a spawn that exited before ever reading the proof -
          // nothing here calls `consumeUpdateAttemptAdoption`.
          return "spawn-never-read";
        }),
    );

    expect(outcome).toMatchObject({
      kind: "ran",
      result: "spawn-never-read",
    });
    // `cancel()` in `finally` must remove it anyway - an unconsumed proof
    // must not sit in the host home waiting to be found.
    expect(await adoptionFiles(layout.rootDir)).toHaveLength(0);
  });

  it("guards before minting: a not-live capability throws DesktopAttemptCapabilityError and writes no proof", async () => {
    const layout = await freshLayout();
    const runSpy = vi.fn(async (_args: readonly string[]) => "unreachable");

    const outcome = await withUpdateContender(
      {
        hostHomeDir: layout.rootDir,
        reason: "minted-adoption-guard-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "desktop-activation-maintenance",
      },
      async (capability) => {
        // Reuse the sibling suite's technique for killing a live capability
        // mid-flight: delete the lock file out from under it.
        await unlink(updateAttemptLockPath(layout.rootDir));

        await expect(
          withMintedAdoption(capability, layout, runSpy),
        ).rejects.toBeInstanceOf(DesktopAttemptCapabilityError);

        return "guard-checked";
      },
    );

    expect(outcome).toMatchObject({
      kind: "lock-not-live",
      verdict: { kind: "lost" },
    });
    expect(runSpy).not.toHaveBeenCalled();
    // Minting never started - no proof file exists to prove it did.
    expect(await adoptionFiles(layout.rootDir)).toHaveLength(0);
  });
});

// Findings 2 + 6 (revalidation round): `publishRestartTombstoneWithAttempt`'s
// flush deadline raced `handle.sync()` against a timer, but the enclosing
// `finally` then did `await handle.close()` on every arm - and
// `FileHandle.close()` waits for pending operations on that handle, so a
// stuck `fsync` was still transitively awaited inside `close()`. The
// deadline changed WHICH promise was awaited, not how long the segment was
// held: exactly the stuck-updating class this epic exists to remove,
// rebuilt inside the removal. The same arm also returned past the outer
// `catch` that cleans up `temp`, leaking a `.stop-intent.<pid>.<time>.tmp`
// on every flush failure.
//
// These two tests exercise both defects together because they share one
// root cause and one fix (detach the close, do the arm's own cleanup).
describe("publishRestartTombstoneWithAttempt - flush deadline (findings 2 + 6)", () => {
  async function runWithCapability<T>(
    layout: HostFsLayout,
    fn: (capability: UpdateMutationCapability) => Promise<T>,
  ): Promise<T> {
    let captured: T | undefined;
    await withUpdateContender(
      {
        hostHomeDir: layout.rootDir,
        reason: "tombstone-flush-deadline-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "desktop-activation-maintenance",
      },
      async (capability) => {
        captured = await fn(capability);
        return "ran";
      },
    );
    // `withUpdateContender` always resolves once the callback does - the
    // capability is only usable inside it, so `captured` is always set by
    // the time we get here.
    return captured as T;
  }

  // Real timers, not faked: the deadline races real `open`/`mkdir`/`writeFile`
  // I/O against a real 5s `setTimeout`, and `vi.advanceTimersByTimeAsync`
  // cannot be trusted to interleave correctly against that real I/O (a first
  // attempt using fake timers here raced ahead of the deadline's own
  // `setTimeout` being armed and hung for the full Vitest test timeout
  // instead). A slightly extended per-test timeout absorbs the real 5s wait.
  it(
    "bounds the flush wait: a stuck fsync cannot hold the segment forever, and resolves not-published",
    { timeout: 8_000 },
    async () => {
      const layout = await freshLayout();
      tombstoneHook.behavior = () => new Promise<void>(() => undefined);
      try {
        const result = await runWithCapability(layout, (capability) =>
          publishRestartTombstoneWithAttempt(capability, layout),
        );

        expect(result.kind).toBe("not-published");
        expect(existsSync(hostStopIntentPath(layout.rootDir))).toBe(false);
      } finally {
        tombstoneHook.behavior = null;
      }
    },
  );

  // Ablated (verification-only, reverted before committing, production
  // untouched): reverted the deadline arm from `void handle.close()` back to
  // the pre-fix `await handle.close(); closed = true;`, then re-ran the test
  // above with its timeout lowered to 3000ms. It failed with Vitest's own
  // "Test timed out in 3000ms" rather than resolving `not-published` - the
  // wrapper's `close()` awaited the never-settling `sync()` above exactly as
  // Node's real `FileHandle.close()` contract would, reproducing the "stuck
  // in restarting forever" class this fix closes. Reverted immediately
  // after, diff-confirmed clean, timeout restored to 8000ms.

  // Tightened per the coordinator's revalidation follow-up: the original
  // draft of this test asserted only absences (no leftover file, no
  // resurrection) after letting the late sync settle - which passes just as
  // green if the fake seam is never reached, or if the late settlement never
  // actually happens. Every assertion below is now a POSITIVE observation:
  // the fake was genuinely hit (seam proof), `rm` and the detached `close`
  // are recorded as ordered events (not inferred timing), the late
  // settlement is directly awaited rather than assumed from elapsed time,
  // and the final directory state is enumerated rather than checked for one
  // name's absence.
  it(
    "a late-succeeding fsync settles strictly after temp is unlinked, and the detached close settlement is directly observed",
    { timeout: 8_000 },
    async () => {
      let releaseSync: (() => void) | undefined;
      const lateSync = new Promise<void>((resolve) => {
        releaseSync = resolve;
      });
      let syncSeamHit = false;
      const layout = await freshLayout();
      tombstoneHook.behavior = () => {
        syncSeamHit = true;
        return lateSync;
      };
      try {
        const result = await runWithCapability(layout, (capability) =>
          publishRestartTombstoneWithAttempt(capability, layout),
        );
        expect(result.kind).toBe("not-published");

        // Seam proof: the production code genuinely reached the fake
        // `sync()` rather than some real, unobserved fsync. Without this,
        // every assertion below would be vacuous - it would pass identically
        // if `publishRestartTombstoneWithAttempt` never called our fake at
        // all.
        expect(syncSeamHit).toBe(true);

        // The deadline-loss arm's own cleanup (finding 6) already ran and
        // settled by the time the function resolved - it is `await`ed on
        // that arm, unlike `close()`. Record its position in the event log
        // before releasing the late sync.
        expect(tombstoneHook.log).toContain("rm-settled");
        const rmIndex = tombstoneHook.log.indexOf("rm-settled");

        // The detached `close()` (`void handle.close()`) was already
        // invoked synchronously in the same branch that called `rm` -
        // capture its promise now, before releasing the gate, so its
        // eventual settlement can be directly awaited rather than assumed.
        expect(tombstoneHook.lastClosePromise).not.toBeNull();
        const closeSettled = tombstoneHook.lastClosePromise;

        // Now let the "late" fsync succeed, simulating it finally landing
        // after the function already returned - and directly observe both
        // the sync and the close it unblocks actually settle.
        releaseSync?.();
        await lateSync;
        await closeSettled;

        // POSITIVE ordering claim: `rm` (temp unlinked) ran strictly BEFORE
        // the late close settled - the index itself is the assertion, not
        // "both eventually happened".
        expect(tombstoneHook.log).toContain("close-settled");
        const closeIndex = tombstoneHook.log.indexOf("close-settled");
        expect(rmIndex).toBeLessThan(closeIndex);
        expect(tombstoneHook.log).toEqual(["rm-settled", "close-settled"]);

        // Final directory state, enumerated rather than a single absence
        // check: nothing survives in the layout root, and an unexpected
        // extra file (which a one-name absence check would miss) fails
        // loudly here.
        const entries = await readdir(layout.rootDir);
        expect(entries).toEqual([]);
      } finally {
        tombstoneHook.behavior = null;
      }
    },
  );

  it("finding 6: a rejecting fsync reports not-published and leaves no leaked temp file behind", async () => {
    const layout = await freshLayout();
    tombstoneHook.behavior = () =>
      Promise.reject(new Error("simulated fsync failure"));
    try {
      const result = await runWithCapability(layout, (capability) =>
        publishRestartTombstoneWithAttempt(capability, layout),
      );

      expect(result.kind).toBe("not-published");
      expect(existsSync(hostStopIntentPath(layout.rootDir))).toBe(false);
      expect(await stopIntentTempFiles(layout.rootDir)).toHaveLength(0);
    } finally {
      tombstoneHook.behavior = null;
    }

    // Ablated (verification-only, reverted, production untouched): removed
    // the `await rm(temp, { force: true }).catch(() => undefined);` line
    // from the deadline-loss arm. Re-ran this exact test: it went red on
    // `stopIntentTempFiles(...)` returning a length of 1 instead of 0 - a
    // real leaked `.stop-intent.<pid>.<time>.tmp`, reproducing exactly what
    // the reviewer reported. Reverted immediately, diff-confirmed clean.
  });

  // Finding 3 (round-2 revalidation): a boolean `withFlushDeadline` result
  // collapsed "the disk rejected the write" into the same `false` as "the
  // deadline expired", so an immediate `EIO`/`ENOSPC` was durably reported to
  // the terminal attempt record as `restart tombstone flush exceeded 5000ms`
  // - a fabricated cause pointing an operator at latency/lock contention
  // instead of the actual disk fault. The fix is `FlushOutcome`, a
  // discriminated `flushed | rejected{cause} | expired`. Both tests below are
  // needed together: asserting only "contains the real error text" would
  // still pass if the string were `EIO ... exceeded 5000ms` (both true at
  // once), so the rejection case also asserts the ABSENCE of the timeout
  // vocabulary, and the expiry case is re-proven with the same shape so the
  // two can't be satisfied by one shared constant string.
  it("a fsync that rejects immediately reports the real disk error, not a fabricated timeout", async () => {
    const layout = await freshLayout();
    tombstoneHook.behavior = () =>
      Promise.reject(
        Object.assign(new Error("input/output error"), { code: "EIO" }),
      );
    try {
      const result = await runWithCapability(layout, (capability) =>
        publishRestartTombstoneWithAttempt(capability, layout),
      );

      expect(result.kind).toBe("not-published");
      if (result.kind !== "not-published") return;
      // Positive: the real cause survives into the diagnostic.
      expect(result.cause).toContain("EIO");
      expect(result.cause).toContain("input/output error");
      // Negative half, load-bearing on its own: a string containing BOTH the
      // real error and the timeout vocabulary would pass the assertion
      // above while still being the bug (a rejection dressed up as a
      // timeout). This is what actually distinguishes "fixed" from
      // "half-fixed".
      expect(result.cause).not.toContain("exceeded");
      expect(result.cause).not.toContain("5000ms");
    } finally {
      tombstoneHook.behavior = null;
    }

    // Ablated (verification-only, reverted, production untouched): restored
    // the pre-fix shape by making `withFlushDeadline` return `false` for
    // BOTH the rejected and expired arms (collapsing the discriminated
    // `FlushOutcome` back to a boolean) and having the caller derive the
    // same fabricated string for every `false`. Re-ran this exact test: it
    // went red on `result.cause).not.toContain("exceeded")` - the message
    // read "restart tombstone flush exceeded 5000ms" despite the fsync
    // having rejected in well under a millisecond, reproducing the reviewer
    // finding exactly. Reverted immediately, diff-confirmed clean.
  });

  it(
    "a fsync that never settles still reports the timeout cause, not the rejection vocabulary",
    { timeout: 8_000 },
    async () => {
      const layout = await freshLayout();
      tombstoneHook.behavior = () => new Promise<void>(() => undefined);
      try {
        const result = await runWithCapability(layout, (capability) =>
          publishRestartTombstoneWithAttempt(capability, layout),
        );

        expect(result.kind).toBe("not-published");
        if (result.kind !== "not-published") return;
        expect(result.cause).toContain("exceeded");
        expect(result.cause).toContain("5000ms");
        // Same negative discipline in the opposite direction: the timeout
        // arm must not borrow rejection language it never had.
        expect(result.cause).not.toContain("EIO");
      } finally {
        tombstoneHook.behavior = null;
      }
    },
  );

  it("reports not-published/stale, and cleans up the temp file, when a backward clock step during the flush makes requestedAtMs FUTURE-dated beyond the deadline", async () => {
    const layout = await freshLayout();
    // `requestedAtMs` is stamped (production line, before this callback ever
    // runs) at very close to this value.
    const stampedAroundMs = Date.now();
    // A holder object rather than a `let`: the assignment happens inside the
    // hook closure, so control-flow narrowing would type the local as still-
    // `null` (then `never` under `?.`) at the `finally` below.
    const dateNowSpy = { current: null as MockInstance<() => number> | null };
    tombstoneHook.behavior = () => {
      // Simulate the wall clock stepping BACKWARD during the flush: by the
      // time the freshness re-check reads `Date.now()` again, it is more
      // than the 5000ms deadline behind `requestedAtMs` - equivalently,
      // `requestedAtMs` now looks FUTURE-dated from the re-check's point of
      // view. Symmetric with the ordinary "too old" case: `Math.abs()`
      // treats both directions identically, so this must go stale exactly
      // like a clock that stepped forward would.
      dateNowSpy.current = vi
        .spyOn(Date, "now")
        .mockReturnValue(stampedAroundMs - 5_000 - 10_000);
      return Promise.resolve();
    };
    try {
      const result = await runWithCapability(layout, (capability) =>
        publishRestartTombstoneWithAttempt(capability, layout),
      );

      expect(result.kind).toBe("not-published");
      if (result.kind !== "not-published") return;
      expect(result.cause).toContain("went stale during flush");
      expect(existsSync(hostStopIntentPath(layout.rootDir))).toBe(false);
      expect(await stopIntentTempFiles(layout.rootDir)).toHaveLength(0);
    } finally {
      tombstoneHook.behavior = null;
      dateNowSpy.current?.mockRestore();
    }
  });
});
