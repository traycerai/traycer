import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// `probeAttemptHolder` is mocked (spy-wrapping the real implementation by
// default) so ONE test can force the "indeterminate" arm deterministically.
// `validateUpdateMutationCapabilityAdoption`'s own disk read
// (`readLockHolder` from `../host-lock/cross-process-lock`) is a SEPARATE
// import this mock never touches, so every other test in this file exercises
// the real conjunctive check against a real lock file end to end.
vi.mock("../lock", async () => {
  const actual = await vi.importActual<typeof import("../lock")>("../lock");
  return { ...actual, probeAttemptHolder: vi.fn(actual.probeAttemptHolder) };
});

import { probeAttemptHolder } from "../lock";
import { updateAttemptRecordPath } from "../paths";
import {
  createUpdateMutationCapabilityAdoption,
  commitAttemptMutationWithCapability,
  rebindUpdateMutationCapabilityLiveness,
  validateUpdateMutationCapabilityAdoption,
  verifyUpdateMutationCapability,
  withUpdateContender,
  withUpdateContenderAdoption,
  type UpdateMutationCapability,
  type UpdateMutationCapabilityAdoption,
} from "../contender";

// Ruling 1's security-relevant surface (design §3.2): an adoption is a
// SECOND way to hold authority, not a bypass. The load-bearing property is
// conjunctive liveness re-taken on every call - identity matching the lock
// file on disk is necessary but never sufficient, because a dead parent
// leaves that identity behind unchanged. Every test here proves either that
// the conjunctive check admits correctly, or that ONE half of it alone would
// have wrongly admitted and the other half is what closes the gap.

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

async function freshHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "contender-adoption-test-"));
  roots.push(root);
  return join(root, "host-home");
}

// Explicit rather than defaulted: the repo's type-safety rules ban default
// parameters so a caller cannot silently inherit a bound it never chose - a
// wait budget is exactly the kind of value a reader should see at the call.
async function waitForFile(path: string, maxWaitMs: number): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const exists = await stat(path).then(
      () => true,
      () => false,
    );
    if (exists) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${path}`);
}

afterEach(async () => {
  vi.mocked(probeAttemptHolder).mockClear();
  await Promise.all(
    children.splice(0).map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null) {
            resolve();
            return;
          }
          child.kill("SIGKILL");
          resolve();
        }),
    ),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("withUpdateContenderAdoption - live-parent case", () => {
  it("admits and runs when the same in-process holder is still the live lock owner", async () => {
    const hostHomeDir = await freshHome();
    let ran = false;

    const outer = await withUpdateContender(
      {
        hostHomeDir,
        reason: "adoption-live-parent-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "attempt-executor",
      },
      async (capability) => {
        const adoption = await createUpdateMutationCapabilityAdoption(
          capability,
          hostHomeDir,
        );

        const adopted = await withUpdateContenderAdoption(
          adoption,
          {
            hostHomeDir,
            reason: "adoption-child-test",
            waitMs: 0,
            pollIntervalMs: 10,
            admission: "legacy-update-shadow",
          },
          async (adoptedCapability) => {
            ran = true;
            const verdict = await verifyUpdateMutationCapability(
              adoptedCapability,
              hostHomeDir,
            );
            expect(verdict).toEqual({ kind: "live" });
            return "adopted-ok";
          },
        );
        expect(adopted).toEqual({ kind: "ran", result: "adopted-ok" });
        return "outer-ok";
      },
    );

    expect(ran).toBe(true);
    expect(outer).toEqual({ kind: "ran", result: "outer-ok" });
  });

  it("refuses immediately on a hostHomeDir mismatch, without probing liveness at all", async () => {
    const hostHomeDir = await freshHome();
    const otherHome = await freshHome();

    const outer = await withUpdateContender(
      {
        hostHomeDir,
        reason: "adoption-wrong-home-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "attempt-executor",
      },
      async (capability) => {
        const adoption = await createUpdateMutationCapabilityAdoption(
          capability,
          hostHomeDir,
        );
        return withUpdateContenderAdoption(
          adoption,
          {
            hostHomeDir: otherHome,
            reason: "adoption-wrong-home-child",
            waitMs: 0,
            pollIntervalMs: 10,
            admission: "legacy-update-shadow",
          },
          async () => "must-not-run",
        );
      },
    );

    expect(outer).toMatchObject({
      kind: "ran",
      result: { kind: "lock-not-live", verdict: { kind: "wrong-host-home" } },
    });
  });

  it("refuses on a token mismatch even though the hostHomeDir and pid otherwise agree", async () => {
    const hostHomeDir = await freshHome();

    const outer = await withUpdateContender(
      {
        hostHomeDir,
        reason: "adoption-token-mismatch-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "attempt-executor",
      },
      async (capability) => {
        const real = await createUpdateMutationCapabilityAdoption(
          capability,
          hostHomeDir,
        );
        const forged: UpdateMutationCapabilityAdoption = {
          ...real,
          holder: { ...real.holder, token: `${real.holder.token}-tampered` },
        };
        return withUpdateContenderAdoption(
          forged,
          {
            hostHomeDir,
            reason: "adoption-token-mismatch-child",
            waitMs: 0,
            pollIntervalMs: 10,
            admission: "legacy-update-shadow",
          },
          async () => "must-not-run",
        );
      },
    );

    expect(outer).toMatchObject({
      kind: "ran",
      result: { kind: "lock-not-live", verdict: { kind: "lost" } },
    });
  });
});

describe("withUpdateContenderAdoption - dead-parent case (real subprocess)", () => {
  it("stale-but-present lock file with matching identity is NOT live - identity alone would have admitted, liveness is what refuses", async () => {
    const hostHomeDir = await freshHome();
    const barrierDir = join(hostHomeDir, "barrier");
    await mkdir(barrierDir, { recursive: true });

    const worker = spawn(
      "bun",
      ["run", join(__dirname, "fixtures", "lock-worker.ts")],
      {
        env: {
          ...process.env,
          WORKER_HOST_HOME_DIR: hostHomeDir,
          WORKER_BARRIER_DIR: barrierDir,
          WORKER_WAIT_MS: "0",
        },
      },
    );
    children.push(worker);
    await waitForFile(join(barrierDir, "held"), 10_000);

    // Read the REAL holder metadata off the lock file the child wrote, while
    // it is still alive - this is exactly what a genuine adoption proof
    // would carry.
    const liveProbe = await probeAttemptHolder({
      hostHomeDir,
      nowMs: Date.now(),
      cacheTtlMs: 0,
    });
    expect(liveProbe.kind).toBe("holder-live");
    if (liveProbe.kind !== "holder-live") return;
    const adoption: UpdateMutationCapabilityAdoption = {
      hostHomeDir,
      holder: liveProbe.holder,
    };

    // Now kill the child WITHOUT letting it release the lock, so the file on
    // disk is untouched - same token, same pid, same start identity - and
    // only the process behind it is gone.
    worker.kill("SIGKILL");
    await new Promise<void>((resolve) => {
      if (worker.exitCode !== null) {
        resolve();
        return;
      }
      worker.once("close", () => resolve());
    });

    // Identity alone (no liveness) still matches: this is the specific hole
    // the conjunctive check exists to close. Proving it explicitly is the
    // point of this test, not incidental.
    await expect(
      validateUpdateMutationCapabilityAdoption(adoption, hostHomeDir),
    ).resolves.toBe(true);

    const adopted = await withUpdateContenderAdoption(
      adoption,
      {
        hostHomeDir,
        reason: "adoption-dead-parent-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "legacy-update-shadow",
      },
      async () => "must-not-run",
    );

    expect(adopted).toMatchObject({
      kind: "lock-not-live",
      verdict: { kind: "lost" },
    });
  }, 20_000);

  it("never authorizes from a cached positive verdict, even one warmed a moment earlier against the same still-present lock", async () => {
    const hostHomeDir = await freshHome();
    const barrierDir = join(hostHomeDir, "barrier");
    await mkdir(barrierDir, { recursive: true });

    const worker = spawn(
      "bun",
      ["run", join(__dirname, "fixtures", "lock-worker.ts")],
      {
        env: {
          ...process.env,
          WORKER_HOST_HOME_DIR: hostHomeDir,
          WORKER_BARRIER_DIR: barrierDir,
          WORKER_WAIT_MS: "0",
        },
      },
    );
    children.push(worker);
    await waitForFile(join(barrierDir, "held"), 10_000);

    // Warm the fleet-status-style cache with a long TTL while the holder is
    // genuinely alive. The fingerprint this caches is keyed on the lock
    // file's own content, which will NOT change once the process dies.
    const warmed = await probeAttemptHolder({
      hostHomeDir,
      nowMs: Date.now(),
      cacheTtlMs: 60_000,
    });
    expect(warmed.kind).toBe("holder-live");
    if (warmed.kind !== "holder-live") return;
    const adoption: UpdateMutationCapabilityAdoption = {
      hostHomeDir,
      holder: warmed.holder,
    };

    worker.kill("SIGKILL");
    await new Promise<void>((resolve) => {
      if (worker.exitCode !== null) {
        resolve();
        return;
      }
      worker.once("close", () => resolve());
    });

    // Called immediately - well inside the 60s window just warmed above - so
    // a cache-consulting implementation would still be serving the stale
    // positive verdict here.
    const adopted = await withUpdateContenderAdoption(
      adoption,
      {
        hostHomeDir,
        reason: "adoption-cache-bypass-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "legacy-update-shadow",
      },
      async () => "must-not-run",
    );

    expect(adopted).toMatchObject({
      kind: "lock-not-live",
      verdict: { kind: "lost" },
    });
  }, 20_000);
});

describe("withUpdateContenderAdoption - indeterminate probe", () => {
  it("refuses rather than admitting when the liveness probe itself cannot conclude", async () => {
    const hostHomeDir = await freshHome();

    const outer = await withUpdateContender(
      {
        hostHomeDir,
        reason: "adoption-indeterminate-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "attempt-executor",
      },
      async (capability) => {
        const adoption = await createUpdateMutationCapabilityAdoption(
          capability,
          hostHomeDir,
        );
        vi.mocked(probeAttemptHolder).mockImplementationOnce(async () => ({
          kind: "indeterminate",
          cause: "test-injected-probe-failure",
        }));
        return withUpdateContenderAdoption(
          adoption,
          {
            hostHomeDir,
            reason: "adoption-indeterminate-child",
            waitMs: 0,
            pollIntervalMs: 10,
            admission: "legacy-update-shadow",
          },
          async () => "must-not-run",
        );
      },
    );

    expect(outer).toMatchObject({
      kind: "ran",
      result: {
        kind: "lock-not-live",
        verdict: {
          kind: "indeterminate",
          cause: "test-injected-probe-failure",
        },
      },
    });
  });
});

describe("withUpdateContenderAdoption - structural: no record write, no handle", () => {
  it("an adopted capability cannot reach commitAttemptMutationWithCapability, even under a plain maintenance admission", async () => {
    const hostHomeDir = await freshHome();

    await withUpdateContender(
      {
        hostHomeDir,
        reason: "adoption-no-write-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "attempt-executor",
      },
      async (capability) => {
        const adoption = await createUpdateMutationCapabilityAdoption(
          capability,
          hostHomeDir,
        );
        await withUpdateContenderAdoption(
          adoption,
          {
            hostHomeDir,
            reason: "adoption-no-write-child",
            waitMs: 0,
            pollIntervalMs: 10,
            admission: "desktop-activation-maintenance",
          },
          async (adoptedCapability) => {
            await expect(
              commitAttemptMutationWithCapability(
                adoptedCapability,
                hostHomeDir,
                {
                  kind: "create",
                  request: {
                    targetVersion: "2.0.0",
                    trigger: "manual",
                    action: "start",
                    expected: null,
                    newAttemptId: "adopted-attempt-1",
                    initialPhase: "preparing",
                    nowIso: "2026-01-01T00:00:00.000Z",
                  },
                },
              ),
            ).rejects.toThrow(/not admitted/);
            return "checked";
          },
        );
      },
    );

    // No record exists: the adopted capability never wrote one.
    await expect(stat(updateAttemptRecordPath(hostHomeDir))).rejects.toThrow();
  });

  // Finding 3 (revalidation round): the acquiring path loses authority when
  // its lock handle releases in its own `finally`; the adopted path had no
  // equivalent boundary, so `capabilityStates`/`issuedCapabilities` kept the
  // capability live past the segment that issued it. A callback that
  // captured the capability and scheduled work outliving the segment could
  // re-verify `live` - the parent's lock is still held, which is exactly
  // what the adopted verdict checks - and enter an actuator OUTSIDE the
  // segment, without the inner CLI lock meant to serialize it. The fix is a
  // `finally` that deletes both map entries on every exit path.
  //
  // Both tests below capture the capability from inside `run`, hold the
  // reference past the point `withUpdateContenderAdoption` has already
  // returned/thrown, and re-verify it against the SAME still-live parent
  // segment - the reviewer's probe inverted: prove the escaped reference is
  // dead, not just that a fresh capability would be.
  it("an escaped capability captured on successful completion verifies dead once the segment has returned, even though the parent lock is still live", async () => {
    const hostHomeDir = await freshHome();
    let escaped: UpdateMutationCapability | undefined;

    const outer = await withUpdateContender(
      {
        hostHomeDir,
        reason: "adoption-escape-success-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "attempt-executor",
      },
      async (capability) => {
        const adoption = await createUpdateMutationCapabilityAdoption(
          capability,
          hostHomeDir,
        );
        const adopted = await withUpdateContenderAdoption(
          adoption,
          {
            hostHomeDir,
            reason: "adoption-escape-success-child",
            waitMs: 0,
            pollIntervalMs: 10,
            admission: "legacy-update-shadow",
          },
          async (adoptedCapability) => {
            escaped = adoptedCapability;
            return "adopted-ok";
          },
        );
        expect(adopted).toEqual({ kind: "ran", result: "adopted-ok" });

        // The segment has returned. The PARENT lock (`capability`, from the
        // outer `withUpdateContender`) is still genuinely live - only the
        // CHILD segment ended. A callback that squirreled `escaped` away
        // (e.g. into a timer or a detached promise chain) must find it dead
        // here, not live.
        expect(escaped).toBeDefined();
        if (escaped !== undefined) {
          const verdict = await verifyUpdateMutationCapability(
            escaped,
            hostHomeDir,
          );
          expect(verdict).toEqual({ kind: "not-issued" });
        }
        return "outer-ok";
      },
    );

    expect(outer).toEqual({ kind: "ran", result: "outer-ok" });
  });

  it("an escaped capability captured before run() throws still verifies dead - finally covers the throw path identically to the return path", async () => {
    const hostHomeDir = await freshHome();
    let escaped: UpdateMutationCapability | undefined;
    const boom = new Error("adopted run blew up");

    const outer = await withUpdateContender(
      {
        hostHomeDir,
        reason: "adoption-escape-throw-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "attempt-executor",
      },
      async (capability) => {
        const adoption = await createUpdateMutationCapabilityAdoption(
          capability,
          hostHomeDir,
        );
        let thrown: unknown;
        try {
          await withUpdateContenderAdoption(
            adoption,
            {
              hostHomeDir,
              reason: "adoption-escape-throw-child",
              waitMs: 0,
              pollIntervalMs: 10,
              admission: "legacy-update-shadow",
            },
            async (adoptedCapability) => {
              escaped = adoptedCapability;
              throw boom;
            },
          );
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBe(boom);

        expect(escaped).toBeDefined();
        if (escaped !== undefined) {
          const verdict = await verifyUpdateMutationCapability(
            escaped,
            hostHomeDir,
          );
          expect(verdict).toEqual({ kind: "not-issued" });
        }
        return "outer-ok";
      },
    );

    expect(outer).toEqual({ kind: "ran", result: "outer-ok" });
  });

  it("an adopted capability yields no lock handle - the liveness-rebind supervisor hook refuses it outright", async () => {
    const hostHomeDir = await freshHome();

    await withUpdateContender(
      {
        hostHomeDir,
        reason: "adoption-no-handle-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "attempt-executor",
      },
      async (capability) => {
        const adoption = await createUpdateMutationCapabilityAdoption(
          capability,
          hostHomeDir,
        );
        await withUpdateContenderAdoption(
          adoption,
          {
            hostHomeDir,
            reason: "adoption-no-handle-child",
            waitMs: 0,
            pollIntervalMs: 10,
            admission: "legacy-update-shadow",
          },
          async (adoptedCapability) => {
            await expect(
              rebindUpdateMutationCapabilityLiveness(
                adoptedCapability,
                process.pid,
                {},
              ),
            ).rejects.toThrow(/state was unavailable/);
            return "checked";
          },
        );
      },
    );
  });
});
