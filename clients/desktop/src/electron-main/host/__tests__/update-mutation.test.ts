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

  // Real timers, not faked: the deadline races real `open`/`mkdir`/`writeFile` I/O against a real 5s `setTimeout`, and `vi.advanceTimersByTimeAsync` cannot be trusted to interleave.
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

        // Without this, every assertion below would be vacuous - it would pass identically if `publishRestartTombstoneWithAttempt` never called our fake at all.
        expect(syncSeamHit).toBe(true);

        expect(tombstoneHook.log).toContain("rm-settled");
        const rmIndex = tombstoneHook.log.indexOf("rm-settled");

        // The detached `close()` (`void handle.close()`) was already invoked synchronously in the same branch that called `rm`.
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

  });

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
      expect(result.cause).not.toContain("exceeded");
      expect(result.cause).not.toContain("5000ms");
    } finally {
      tombstoneHook.behavior = null;
    }

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
