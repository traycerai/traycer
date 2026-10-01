import { execFileSync, spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  updateAttemptLockPath,
  withUpdateContender,
} from "@traycer-clients/shared/host-update";
import {
  readLockHolder,
  type LockHolderProbe,
} from "@traycer-clients/shared/host-lock/cross-process-lock";

const homeRef = vi.hoisted(() => ({ current: "" }));
vi.mock("../../store/paths", () => ({
  hostHomeDir: () => homeRef.current,
}));

import { defaultRunHostStartDeps } from "../../commands/host-start";
import {
  __setBeforeHostStartAdoptionClaimHookForTest,
  __setBeforeHostStartAdoptionReadHookForTest,
  consumeHostStartAdoption,
  publishHostStartAdoption,
  readHostStartAdoptionNonce,
  type HostStartAdoptionConsumeResult,
} from "../host-start-adoption";
import { HOST_START_ADOPTION_MAX_AGE_MS } from "../../service/spawn-edge-bounds";

const roots: string[] = [];

async function freshHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "host-start-adoption-test-"));
  roots.push(root);
  return join(root, "host-home");
}

const options = (hostHomeDir: string) => ({
  environment: "production" as const,
  hostHomeDir,
  reason: "host-start-adoption-test",
  waitMs: 0,
  pollIntervalMs: 10,
  admission: "recovery-maintenance" as const,
});
const serviceLabel = "com.traycer.host";

async function expectPresentEntryNotAbsent(): Promise<void> {
  const result = await consumeHostStartAdoption("production", null, null);
  expect(result.kind).not.toBe("absent");
}

async function readAdoptionNonce(hostHomeDir: string): Promise<string> {
  const parsed = JSON.parse(
    await readFile(join(hostHomeDir, ".host-start-adoption.json"), "utf8"),
  ) as { readonly nonce: string };
  return parsed.nonce;
}

afterEach(async () => {
  __setBeforeHostStartAdoptionClaimHookForTest(null);
  __setBeforeHostStartAdoptionReadHookForTest(null);
  homeRef.current = "";
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("host-start parent adoption", () => {
  it("lets the service-launched supervisor consume one live parent proof without reacquiring", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    let callbackCalls = 0;

    const outcome = await withUpdateContender(
      {
        hostHomeDir,
        reason: "parent-service-restart",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "recovery-maintenance",
      },
      async (capability) => {
        await publishHostStartAdoption(
          capability,
          options(hostHomeDir),
          serviceLabel,
          "terminal",
        );
        const nonce = await readAdoptionNonce(hostHomeDir);
        const admission = await defaultRunHostStartDeps.admitHostStartSpawn(
          {
            environment: "production",
            cwd: null,
            serviceLabel,
            adoptionNonce: nonce,
          },
          async () => {
            callbackCalls += 1;
            const child = spawn(process.execPath, ["-e", ""]);
            child.unref();
            return child;
          },
          () => undefined,
          { consumed: null, onGranted: () => undefined },
        );
        expect(admission.kind).toBe("ran");
        return admission;
      },
    );

    expect(outcome.kind).toBe("ran");
    expect(callbackCalls).toBe(1);
    await expect(
      readFile(join(hostHomeDir, ".host-start-adoption.json")),
    ).rejects.toThrow();
  });

  it("uses canonical admission for standalone and crash relaunches after the one-shot proof is consumed", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    const first = await consumeHostStartAdoption("production", null, null);
    expect(first).toEqual({ kind: "absent" });

    let callbackCalls = 0;
    let beside = 0;
    const admission = await defaultRunHostStartDeps.admitHostStartSpawn(
      { environment: "production", cwd: null },
      async () => {
        callbackCalls += 1;
        const child = spawn(process.execPath, ["-e", ""]);
        child.unref();
        return child;
      },
      () => {
        beside += 1;
      },
      { consumed: null, onGranted: () => undefined },
    );
    expect(admission.kind).toBe("ran");
    expect(callbackCalls).toBe(1);
    // No durable attempt stands here, so the supervisor has nothing to
    // announce and must stay silent rather than log a line about a record that
    // does not exist. This is the counter's only load-bearing assertion: the
    // adoption-grant test above returns before the contender runs, so a
    // counter there would watch nothing.
    expect(beside).toBe(0);
  });

  it("rejects a forged, wrong-home, expired, or stale-token adoption instead of spawning", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    const adoptionPath = join(hostHomeDir, ".host-start-adoption.json");
    await mkdir(hostHomeDir, { recursive: true });
    await writeFile(adoptionPath, "not-json", "utf8");
    expect(await consumeHostStartAdoption("production", null, null)).toEqual({
      kind: "refused",
      reason: "host-start adoption is malformed",
    });

    await rm(adoptionPath, { recursive: true, force: true });
    await mkdir(adoptionPath);
    expect(await consumeHostStartAdoption("production", null, null)).toEqual({
      kind: "error",
      reason: "host-start adoption could not be read",
    });
    await rm(adoptionPath, { recursive: true, force: true });

    // `version: 1` (not 2) makes `parseAdoption` reject this outright before
    // any age check runs - so the exact age here is immaterial to which
    // predicate this hits (parsing fails first, every time); the age is
    // still moved off the raw `120_000` for consistency, in case a future
    // reader assumes it is load-bearing.
    await writeFile(
      adoptionPath,
      JSON.stringify({
        version: 1,
        issuedAtMs: Date.now() - (HOST_START_ADOPTION_MAX_AGE_MS + 1_000),
        adoption: { hostHomeDir, holder: {} },
      }),
      "utf8",
    );
    expect(
      await consumeHostStartAdoption("production", serviceLabel, null),
    ).toEqual({
      kind: "refused",
      reason: expect.stringContaining("malformed"),
    });

    const otherHome = await freshHome();
    await mkdir(otherHome, { recursive: true });
    await withUpdateContender(
      {
        hostHomeDir,
        reason: "host-start-adoption-forgery-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "recovery-maintenance",
      },
      async (capability) => {
        await publishHostStartAdoption(
          capability,
          options(hostHomeDir),
          serviceLabel,
          "terminal",
        );
        const proof = JSON.parse(await readFile(adoptionPath, "utf8")) as {
          adoption: { hostHomeDir: string; holder: { token: string | null } };
          issuedAtMs: number;
          version: number;
          nonce: string;
        };

        await writeFile(
          join(otherHome, ".host-start-adoption.json"),
          JSON.stringify(proof),
          "utf8",
        );
        homeRef.current = otherHome;
        expect(
          await consumeHostStartAdoption(
            "production",
            serviceLabel,
            proof.nonce,
          ),
        ).toEqual({
          kind: "refused",
          reason: expect.stringContaining("parent was not live"),
        });

        homeRef.current = hostHomeDir;
        await writeFile(
          adoptionPath,
          JSON.stringify({
            ...proof,
            adoption: {
              ...proof.adoption,
              holder: {
                ...proof.adoption.holder,
                token: "forged-token",
              },
            },
          }),
          "utf8",
        );
        expect(
          await consumeHostStartAdoption(
            "production",
            serviceLabel,
            proof.nonce,
          ),
        ).toEqual({
          kind: "refused",
          reason: expect.stringContaining("parent was not live"),
        });
      },
    );
  });

  // `symlink()` is EPERM for a Windows developer without the create-
  // symbolic-link privilege, so the two symlink-creating cases skip there
  // rather than fail - the same guard the FIFO case below already carries.
  it.skipIf(process.platform === "win32")(
    "fails closed for a dangling canonical adoption symlink",
    async () => {
      const hostHomeDir = await freshHome();
      homeRef.current = hostHomeDir;
      const adoptionPath = join(hostHomeDir, ".host-start-adoption.json");
      await mkdir(hostHomeDir, { recursive: true });
      await symlink(join(hostHomeDir, "missing-proof.json"), adoptionPath);
      await expectPresentEntryNotAbsent();
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails closed after a deterministic canonical symlink replacement",
    async () => {
      const hostHomeDir = await freshHome();
      homeRef.current = hostHomeDir;
      const adoptionPath = join(hostHomeDir, ".host-start-adoption.json");
      const secondTarget = join(hostHomeDir, "second-proof.json");
      const replacement = join(hostHomeDir, ".replacement-proof");
      await mkdir(hostHomeDir, { recursive: true });
      await writeFile(adoptionPath, "not-json", "utf8");
      await writeFile(secondTarget, "still-not-json", "utf8");
      await symlink(secondTarget, replacement);
      __setBeforeHostStartAdoptionReadHookForTest(async () => {
        await rm(adoptionPath, { force: true });
        await rename(replacement, adoptionPath);
      });
      await expectPresentEntryNotAbsent();
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails closed for a FIFO at the canonical adoption path",
    async () => {
      const hostHomeDir = await freshHome();
      homeRef.current = hostHomeDir;
      const adoptionPath = join(hostHomeDir, ".host-start-adoption.json");
      await mkdir(hostHomeDir, { recursive: true });
      execFileSync("mkfifo", [adoptionPath]);
      const startedAt = Date.now();
      await expectPresentEntryNotAbsent();
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    },
  );

  // A chmod-0 file only actually denies reads for a non-root, non-Windows
  // process: Windows `fs` permission bits do not gate readability the same
  // way, and root bypasses the DAC check entirely, so this reliably reaches
  // the intended "unreadable" path only under a normal POSIX, non-root user.
  const cannotDenyReads =
    process.platform === "win32" ||
    (typeof process.getuid === "function" && process.getuid() === 0);

  it.skipIf(cannotDenyReads)(
    "fails closed for a permission-error adoption entry",
    async () => {
      const hostHomeDir = await freshHome();
      homeRef.current = hostHomeDir;
      const adoptionPath = join(hostHomeDir, ".host-start-adoption.json");
      await mkdir(hostHomeDir, { recursive: true });
      await writeFile(adoptionPath, "not-json", "utf8");
      await chmod(adoptionPath, 0);
      try {
        const result = await consumeHostStartAdoption("production", null, null);
        expect(result).toEqual({
          kind: "error",
          reason: "host-start adoption could not be read",
        });
      } finally {
        await chmod(adoptionPath, 0o600).catch(() => undefined);
      }
    },
  );

  it("atomically claims one intended proof while a different host-start sees no proof", async () => {
    const hostHomeDir = await freshHome();
    const otherHome = await freshHome();
    homeRef.current = hostHomeDir;

    await withUpdateContender(
      {
        hostHomeDir,
        reason: "host-start-adoption-concurrent-claim-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "recovery-maintenance",
      },
      async (capability) => {
        await publishHostStartAdoption(
          capability,
          options(hostHomeDir),
          serviceLabel,
          "terminal",
        );

        // Capture each target before the first await. The second invocation
        // models a concurrent supervisor for another host; it must not claim
        // the proof written for the intended host.
        const nonce = await readAdoptionNonce(hostHomeDir);
        const intended = consumeHostStartAdoption(
          "production",
          serviceLabel,
          nonce,
        );
        homeRef.current = otherHome;
        const differentHost = consumeHostStartAdoption(
          "production",
          serviceLabel,
          nonce,
        );
        const [intendedResult, differentHostResult] = await Promise.all([
          intended,
          differentHost,
        ]);

        expect(intendedResult.kind).toBe("grant");
        expect(differentHostResult).toEqual({ kind: "absent" });
        if (intendedResult.kind === "grant") {
          await expect(intendedResult.grant.acknowledgeSpawn()).resolves.toBe(
            true,
          );
          await intendedResult.grant.abandon();
        }
      },
    );
  });

  // The window is pinned only by arithmetic elsewhere
  // (`host-start-adoption-window.test.ts`); nothing on the consumer side
  // exercised the actual boundary until now.
  it("a LIVE parent's grant aged just past the OLD 60s window is still ADOPTED - the window widened to 120s", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;

    await withUpdateContender(
      {
        hostHomeDir,
        reason: "host-start-adoption-window-widened-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "recovery-maintenance",
      },
      async (capability) => {
        await publishHostStartAdoption(
          capability,
          options(hostHomeDir),
          serviceLabel,
          "terminal",
        );
        const path = join(hostHomeDir, ".host-start-adoption.json");
        const proof = JSON.parse(await readFile(path, "utf8")) as {
          issuedAtMs: number;
          nonce: string;
        };
        // Just past the OLD 60s window, well inside the current one.
        await writeFile(
          path,
          JSON.stringify({ ...proof, issuedAtMs: Date.now() - 61_000 }),
          "utf8",
        );

        const result = await consumeHostStartAdoption(
          "production",
          serviceLabel,
          proof.nonce,
        );
        expect(result.kind).toBe("grant");
        if (result.kind === "grant") {
          await expect(result.grant.acknowledgeSpawn()).resolves.toBe(true);
          await result.grant.abandon();
        }
      },
    );
  });

  it("the same shape aged past the ACTUAL window is not adopted", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;

    await withUpdateContender(
      {
        hostHomeDir,
        reason: "host-start-adoption-window-expired-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "recovery-maintenance",
      },
      async (capability) => {
        await publishHostStartAdoption(
          capability,
          options(hostHomeDir),
          serviceLabel,
          "terminal",
        );
        const path = join(hostHomeDir, ".host-start-adoption.json");
        const proof = JSON.parse(await readFile(path, "utf8")) as {
          issuedAtMs: number;
          nonce: string;
        };
        await writeFile(
          path,
          JSON.stringify({
            ...proof,
            issuedAtMs: Date.now() - (HOST_START_ADOPTION_MAX_AGE_MS + 1_000),
          }),
          "utf8",
        );

        // The expiry check runs ahead of the nonce check on this path too
        // (see `consumeHostStartAdoption`), so a nonce-bearing consume of an
        // expired proof is `absent`, not a nonce-mismatch refusal.
        const result = await consumeHostStartAdoption(
          "production",
          serviceLabel,
          proof.nonce,
        );
        expect(result).toEqual({ kind: "absent" });
      },
    );
  });

  it("reports a lost same-home concurrent claim after both readers observe the proof", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    let observed = 0;
    let releaseHook: (() => void) | null = null;
    let releaseObserved: (() => void) | null = null;
    const bothObserved = new Promise<void>((resolve) => {
      releaseObserved = resolve;
    });
    const hookGate = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    __setBeforeHostStartAdoptionClaimHookForTest(async () => {
      observed += 1;
      if (observed === 2) releaseObserved?.();
      await hookGate;
    });

    await withUpdateContender(
      {
        hostHomeDir,
        reason: "host-start-adoption-same-proof-race-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "recovery-maintenance",
      },
      async (capability) => {
        await publishHostStartAdoption(
          capability,
          options(hostHomeDir),
          serviceLabel,
          "terminal",
        );
        const nonce = await readAdoptionNonce(hostHomeDir);
        const first = consumeHostStartAdoption(
          "production",
          serviceLabel,
          nonce,
        );
        const second = consumeHostStartAdoption(
          "production",
          serviceLabel,
          nonce,
        );
        await bothObserved;
        releaseHook?.();
        const results = await Promise.all([first, second]);
        expect(
          results.filter((result) => result.kind === "grant"),
        ).toHaveLength(1);
        expect(results.filter((result) => result.kind === "lost")).toHaveLength(
          1,
        );
        expect(results.every((result) => result.kind !== "absent")).toBe(true);
        const loser = results.find((result) => result.kind === "lost");
        expect(loser).toEqual({
          kind: "lost",
          reason: expect.stringContaining("claimed by another"),
        });
        for (const result of results) {
          if (result.kind === "grant") await result.grant.abandon();
        }
      },
    );
  });

  it("refuses a wrong or missing service label instead of falling back to admission", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    await withUpdateContender(
      {
        hostHomeDir,
        reason: "host-start-adoption-service-label-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "recovery-maintenance",
      },
      async (capability) => {
        await publishHostStartAdoption(
          capability,
          options(hostHomeDir),
          serviceLabel,
          "terminal",
        );
        const nonce = await readAdoptionNonce(hostHomeDir);
        await expect(
          consumeHostStartAdoption("production", serviceLabel, "wrong-nonce"),
        ).resolves.toEqual({
          kind: "refused",
          reason: expect.stringContaining("nonce did not match"),
        });
        await expect(
          consumeHostStartAdoption("production", "com.traycer.other", null),
        ).resolves.toEqual({
          kind: "refused",
          reason: expect.stringContaining("different service label"),
        });
        await expect(
          consumeHostStartAdoption("production", null, null),
        ).resolves.toEqual({
          kind: "refused",
          reason: expect.stringContaining("service-labelled launch"),
        });
        const missingNonce = await consumeHostStartAdoption(
          "production",
          serviceLabel,
          null,
        );
        expect(missingNonce).toEqual({
          kind: "refused",
          reason: expect.stringContaining("nonce"),
        });
        expect(nonce).toMatch(/^[0-9a-f-]+$/);
      },
    );
  });

  it("does not acknowledge a child after the parent proof is released between validation and spawn ACK", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    await withUpdateContender(
      {
        hostHomeDir,
        reason: "host-start-adoption-ack-gate-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "recovery-maintenance",
      },
      async (capability) => {
        await publishHostStartAdoption(
          capability,
          options(hostHomeDir),
          serviceLabel,
          "terminal",
        );
        const consumed = await consumeHostStartAdoption(
          "production",
          serviceLabel,
          await readAdoptionNonce(hostHomeDir),
        );
        expect(consumed.kind).toBe("grant");
        await rm(updateAttemptLockPath(hostHomeDir), { force: true });
        if (consumed.kind === "grant") {
          await expect(consumed.grant.acknowledgeSpawn()).resolves.toBe(false);
          await consumed.grant.abandon();
        }
      },
    );
  });
});

describe("consumeHostStartAdoption — the nonce-less path applies the age bound", () => {
  // Codex #1. The refutation first, because it changes what the fix is: the
  // reported cause ("a proof is not removed when validation returns false
  // after publisher death") does NOT hold — the labelled path's `!parentLive`
  // branch calls `abandon()`, which removes the claimed proof.
  //
  // The real hole is narrower and is here: `HOST_START_ADOPTION_MAX_AGE_MS` is
  // applied on the claimed-candidate check and in `readHostStartAdoptionNonce`,
  // and was NOT applied on the nonce-less refusal path. A publisher that dies
  // between publish and consume leaves a proof behind; the labelled path erases
  // an expired one on its next attempt, but a bare `host start` never takes
  // that path — so a standalone crash-loop is refused on every iteration by a
  // grant nobody can still use.
  it("an EXPIRED proof no longer refuses a standalone start", async () => {
    const hostHomeDir = await freshHome();
    const serviceLabel = "ai.traycer.host.agent";
    homeRef.current = hostHomeDir;
    let result: HostStartAdoptionConsumeResult | null = null;
    await withUpdateContender(
      {
        hostHomeDir,
        reason: "host-start-adoption-expiry-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "recovery-maintenance",
      },
      async (capability) => {
        await publishHostStartAdoption(
          capability,
          options(hostHomeDir),
          serviceLabel,
          "terminal",
        );
        const path = join(hostHomeDir, ".host-start-adoption.json");
        // Age the REAL proof rather than hand-rolling one, so every other
        // field stays exactly what the publisher wrote.
        const proof = JSON.parse(await readFile(path, "utf8")) as {
          issuedAtMs: number;
        };
        await writeFile(
          path,
          JSON.stringify({
            ...proof,
            issuedAtMs: Date.now() - (HOST_START_ADOPTION_MAX_AGE_MS + 1_000),
          }),
          "utf8",
        );
        // Consumed INSIDE the contender's callback, with the parent
        // capability still LIVE, so expiry - not `readOrphanedProof`'s
        // dead-parent path - is the only thing that can make this read as
        // absent. Ablation: with `readOrphanedProof` removed entirely, this
        // still goes red (proving it, not the orphan path, is what admits
        // here) - a consume made after the contender returns would not.
        result = await consumeHostStartAdoption("production", null, null);
      },
    );
    if (result === null) throw new Error("consume never ran");
    expect(result).toEqual({ kind: "absent" });
  });

  it("a FRESH proof with a LIVE parent still refuses a standalone start — the fail-closed arm is intact", async () => {
    // The paired direction. The age bound must not become a way to bypass the
    // grant: an outstanding, still-valid proof is reserved for the
    // service-labelled child, and letting a bare start through would recreate
    // the parent-lock/child-lock cycle the proof exists to avoid.
    //
    // Consumed INSIDE the contender's callback, on purpose: `readOrphanedProof`
    // now reads a dead-parent proof as absent on this exact path (nonce-less,
    // standalone), so this negative only stays a negative while the parent
    // capability is still live. The dead-parent counterpart is covered
    // separately below ("a dead-parent proof ... admits instead of refusing").
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    await withUpdateContender(
      {
        hostHomeDir,
        reason: "host-start-adoption-fresh-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "recovery-maintenance",
      },
      async (capability) => {
        await publishHostStartAdoption(
          capability,
          options(hostHomeDir),
          "ai.traycer.host.agent",
          "terminal",
        );

        expect(
          await consumeHostStartAdoption("production", null, null),
        ).toEqual({
          kind: "refused",
          reason:
            "host-start adoption is reserved for a service-labelled launch",
        });
      },
    );
  });

  it("a dead-parent proof with no nonce admits instead of refusing — option 2, the orphan path", async () => {
    // The publisher can die between publishing and its child's consume; this
    // models that by consuming AFTER the contender's callback returns, so the
    // lock the proof's parent held is already released. Before `readOrphanedProof`
    // this refused every retry until the proof aged out; now it reads as an
    // ordinary absence and falls through to admission, exactly like a launch
    // with no proof at all - see `consumeHostStartAdoption`.
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    await withUpdateContender(
      {
        hostHomeDir,
        reason: "host-start-adoption-dead-parent-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "recovery-maintenance",
      },
      async (capability) => {
        await publishHostStartAdoption(
          capability,
          options(hostHomeDir),
          "ai.traycer.host.agent",
          "terminal",
        );
      },
    );

    const result = await consumeHostStartAdoption("production", null, null);
    expect(result).toEqual({ kind: "absent" });
    // The proof is left in place: removal belongs to its publisher's
    // `cancel`, never to a consumer that read it as absent.
    const proofStillThere = await readFile(
      join(hostHomeDir, ".host-start-adoption.json"),
      "utf8",
    );
    expect(proofStillThere.length).toBeGreaterThan(0);

    let callbackCalls = 0;
    const observed: { lock: LockHolderProbe | null } = { lock: null };
    const admission = await defaultRunHostStartDeps.admitHostStartSpawn(
      { environment: "production", cwd: null },
      async () => {
        callbackCalls += 1;
        // Ordinary admission contends the update-attempt lock for the
        // duration of `run`; a grant would not, which is the proof that
        // this took the admission path rather than being handed a grant.
        observed.lock = await readLockHolder(
          updateAttemptLockPath(hostHomeDir),
        );
        const child = spawn(process.execPath, ["-e", ""]);
        child.unref();
        return child;
      },
      () => undefined,
      { consumed: null, onGranted: () => undefined },
    );
    expect(admission.kind).toBe("ran");
    expect(callbackCalls).toBe(1);
    expect(observed.lock?.kind).toBe("held");
    expect(
      observed.lock?.kind === "held" &&
        observed.lock.holder.pid === process.pid,
    ).toBe(true);
  });

  // Production change B: `adoptionGrantExpired` became SYMMETRIC
  // (`Math.abs(now - issuedAtMs) > MAX_AGE`). Every test above only ever
  // ages a proof into the PAST, which the old asymmetric predicate already
  // handled — it does not exercise the actual fix. A FUTURE-dated
  // `issuedAtMs` (a backwards clock step, or a corrupted publisher stamp)
  // must read as expired too, exactly like a stale one, rather than reading
  // as an outstanding grant forever.
  it("a FUTURE-dated proof is ALSO treated as expired on the standalone path — the symmetric bound", async () => {
    // Same isolation as the past-dated expiry test above: consumed INSIDE
    // the contender's callback, parent LIVE throughout, so the symmetric
    // `Math.abs` check - not `readOrphanedProof`'s dead-parent path - is the
    // only thing that can make this read as absent. Consuming after the
    // contender returns (the shape this test used to have) would pass even
    // if `Math.abs` were dropped: a future timestamp reads as NOT expired by
    // the asymmetric check, falls through to `readOrphanedProof`, and still
    // comes back absent because the parent is dead - proving nothing about
    // the symmetric bound this test is named for.
    const hostHomeDir = await freshHome();
    const serviceLabel = "ai.traycer.host.agent";
    homeRef.current = hostHomeDir;
    let result: HostStartAdoptionConsumeResult | null = null;
    await withUpdateContender(
      {
        hostHomeDir,
        reason: "host-start-adoption-future-expiry-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "recovery-maintenance",
      },
      async (capability) => {
        await publishHostStartAdoption(
          capability,
          options(hostHomeDir),
          serviceLabel,
          "terminal",
        );
        const path = join(hostHomeDir, ".host-start-adoption.json");
        // Age the REAL proof INTO THE FUTURE rather than hand-rolling one, so
        // every other field stays exactly what the publisher wrote. Derived
        // rather than a bare 10 minutes, for the same reason the past-dated
        // fixtures moved off `120_000`: a magic offset that happens to clear
        // the window proves less than one pinned to the actual bound.
        const proof = JSON.parse(await readFile(path, "utf8")) as {
          issuedAtMs: number;
        };
        await writeFile(
          path,
          JSON.stringify({
            ...proof,
            issuedAtMs: Date.now() + HOST_START_ADOPTION_MAX_AGE_MS + 1_000,
          }),
          "utf8",
        );
        result = await consumeHostStartAdoption("production", null, null);
      },
    );
    if (result === null) throw new Error("consume never ran");
    expect(result).toEqual({ kind: "absent" });
  });
});

describe("readHostStartAdoptionNonce — production change B: the symmetric age bound", () => {
  // Not previously covered by this suite at all - every existing assertion
  // on this reader lived only in the doc-comment cross-references inside
  // the two describe blocks below. `readHostStartAdoptionNonce` is the
  // reader that steers a launch onto the labelled, nonce-less consume path
  // once a proof expires (see that block's doc comment), so its own
  // expiry behavior needs direct coverage, not just an inference from its
  // downstream effect.
  it("returns null for a future-dated proof, exactly as it already does for a past-dated one", async () => {
    const hostHomeDir = await freshHome();
    const serviceLabel = "ai.traycer.host.agent";
    homeRef.current = hostHomeDir;
    const path = join(hostHomeDir, ".host-start-adoption.json");
    await withUpdateContender(
      {
        hostHomeDir,
        reason: "host-start-adoption-nonce-reader-future-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "recovery-maintenance",
      },
      async (capability) => {
        await publishHostStartAdoption(
          capability,
          options(hostHomeDir),
          serviceLabel,
          "terminal",
        );

        // Control, run INSIDE the contender's callback: the final step of
        // `readHostStartAdoptionNonce` re-validates the parent capability is
        // still live, which is only true while `withUpdateContender` still
        // holds it. A fresh proof yields the real nonce.
        await expect(
          readHostStartAdoptionNonce("production", serviceLabel),
        ).resolves.toEqual(expect.any(String));

        const proof = JSON.parse(await readFile(path, "utf8")) as {
          issuedAtMs: number;
        };
        await writeFile(
          path,
          JSON.stringify({
            ...proof,
            issuedAtMs: Date.now() + HOST_START_ADOPTION_MAX_AGE_MS + 1_000,
          }),
          "utf8",
        );
        // Expiry short-circuits before the parent-capability re-check, so
        // this arm's `null` is provably about the age bound, not about
        // capability having lapsed.
        await expect(
          readHostStartAdoptionNonce("production", serviceLabel),
        ).resolves.toBeNull();
      },
    );
  });
});

describe("consumeHostStartAdoption — the LABELLED path applies the age bound too", () => {
  // Codex round 3. The follow-up to the block above, and a class member the
  // first fix missed: the age bound went onto the nonce-less STANDALONE path
  // while the labelled path was left without it. The comment written there even
  // enumerated the readers that already had the bound, and the labelled consume
  // path — a third reader — was not among them and was not checked.
  //
  // Expiry is what steers a launch onto this path, which is why the gap is
  // reachable rather than theoretical. `readHostStartAdoptionNonce` applies the
  // age bound, so an expired proof makes `host adoption-nonce` yield nothing,
  // and the emitted launcher re-execs `host start --service-label <label>` with
  // no `--adoption-nonce` at all. That arrives here as (labelled, nonce=null)
  // against a pending read that is still "valid", because `readPendingAdoption`
  // does no age filtering — and the nonce check refused it, on every
  // service-manager retry, with no path to the post-claim expiry check.
  const LABEL = "ai.traycer.host.agent";

  async function publishThenAge(ageMs: number, label: string): Promise<string> {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    await withUpdateContender(
      {
        hostHomeDir,
        reason: "host-start-adoption-labelled-expiry-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "recovery-maintenance",
      },
      async (capability) => {
        await publishHostStartAdoption(
          capability,
          options(hostHomeDir),
          label,
          "terminal",
        );
      },
    );
    if (ageMs > 0) {
      const path = join(hostHomeDir, ".host-start-adoption.json");
      // Age the REAL proof rather than hand-rolling one, so every other field
      // stays exactly what the publisher wrote — a fabricated proof could trip
      // an earlier guard and pass this test for the wrong reason.
      const proof = JSON.parse(await readFile(path, "utf8")) as {
        issuedAtMs: number;
      };
      await writeFile(
        path,
        JSON.stringify({ ...proof, issuedAtMs: Date.now() - ageMs }),
        "utf8",
      );
    }
    return hostHomeDir;
  }

  // `publishThenAge` (below) returns AFTER its contender's callback has
  // resolved, so a proof aged by it is also orphaned by the time the caller
  // consumes - `readOrphanedProof` would admit it even if expiry did not.
  // These two EXPIRED tests need the age bound to be the ONLY thing that can
  // yield `absent`, so they age and consume from INSIDE the callback
  // instead, with the parent capability still LIVE throughout.
  async function publishAgeAndConsumeWithLiveParent(
    ageMs: number,
    publishLabel: string,
    consumeLabel: string,
  ): Promise<HostStartAdoptionConsumeResult> {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    let result: HostStartAdoptionConsumeResult | null = null;
    await withUpdateContender(
      {
        hostHomeDir,
        reason: "host-start-adoption-labelled-expiry-live-parent-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "recovery-maintenance",
      },
      async (capability) => {
        await publishHostStartAdoption(
          capability,
          options(hostHomeDir),
          publishLabel,
          "terminal",
        );
        const path = join(hostHomeDir, ".host-start-adoption.json");
        const proof = JSON.parse(await readFile(path, "utf8")) as {
          issuedAtMs: number;
        };
        await writeFile(
          path,
          JSON.stringify({ ...proof, issuedAtMs: Date.now() - ageMs }),
          "utf8",
        );
        result = await consumeHostStartAdoption(
          "production",
          consumeLabel,
          null,
        );
      },
    );
    if (result === null) throw new Error("consume never ran");
    return result;
  }

  it("an EXPIRED proof no longer refuses a labelled, nonce-less start", async () => {
    // Ablation: with both `readOrphanedProof` call sites removed, this goes
    // red ("refused: reserved for a service-labelled launch" /
    // "did not match") - proving the expiry check above them, not the
    // orphan path, is what admits here while the parent is still live.
    const result = await publishAgeAndConsumeWithLiveParent(
      HOST_START_ADOPTION_MAX_AGE_MS + 1_000,
      LABEL,
      LABEL,
    );

    expect(result).toEqual({ kind: "absent" });
  });

  it("an EXPIRED proof bound to a DIFFERENT label also admits, not refuses", async () => {
    // Why the bound is ordered ahead of the label-binding check: an expired
    // proof left by some other label would otherwise wedge THIS launcher with
    // "bound to a different service label" on every retry, which is the same
    // indefinite refusal wearing a different reason string.
    const result = await publishAgeAndConsumeWithLiveParent(
      HOST_START_ADOPTION_MAX_AGE_MS + 1_000,
      "ai.traycer.host.other",
      LABEL,
    );

    expect(result).toEqual({ kind: "absent" });
  });

  // `publishThenAge` returns after its contender's callback has resolved, so
  // by the time the caller consumes, the parent capability is already dead
  // and `readOrphanedProof` intercepts before either check below ever runs.
  // These two negatives are only still negatives while the parent is LIVE, so
  // the consume has to happen INSIDE the contender's callback - the paired
  // dead-parent behavior for each is covered by the two "admits instead of
  // refusing" tests that follow.
  async function publishAndConsumeWithLiveParent(
    publishLabel: string,
    consumeLabel: string,
  ): Promise<HostStartAdoptionConsumeResult> {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    let result: HostStartAdoptionConsumeResult | null = null;
    await withUpdateContender(
      {
        hostHomeDir,
        reason: "host-start-adoption-labelled-live-parent-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "recovery-maintenance",
      },
      async (capability) => {
        await publishHostStartAdoption(
          capability,
          options(hostHomeDir),
          publishLabel,
          "terminal",
        );
        result = await consumeHostStartAdoption(
          "production",
          consumeLabel,
          null,
        );
      },
    );
    if (result === null) throw new Error("consume never ran");
    return result;
  }

  it("a FRESH proof with a LIVE parent still refuses a labelled start with NO nonce — the capability discipline is intact", async () => {
    // The load-bearing negative. The age bound must not become a way to launch
    // without presenting the nonce: while the grant is still live, a labelled
    // start that cannot produce the nonce is exactly the case the proof exists
    // to refuse. If this ever goes green alongside the dead-parent admission
    // test below, the fix has turned into a nonce bypass.
    expect(await publishAndConsumeWithLiveParent(LABEL, LABEL)).toEqual({
      kind: "refused",
      reason:
        "host-start adoption nonce did not match the pending service launch",
    });
  });

  // Drives `admitHostStartSpawn` the way the emitted launcher actually calls
  // it once its proof reads as absent: labelled, with no nonce. `run` being
  // called once, holding the update-attempt lock for its own duration, is
  // the proof this took the CONTENDED admission path rather than being
  // handed a grant (a grant never touches that lock).
  async function assertAdmitsOrdinarily(
    hostHomeDir: string,
    label: string,
  ): Promise<void> {
    let callbackCalls = 0;
    const observed: { lock: LockHolderProbe | null } = { lock: null };
    const admission = await defaultRunHostStartDeps.admitHostStartSpawn(
      {
        environment: "production",
        cwd: null,
        serviceLabel: label,
        adoptionNonce: null,
      },
      async () => {
        callbackCalls += 1;
        observed.lock = await readLockHolder(
          updateAttemptLockPath(hostHomeDir),
        );
        const child = spawn(process.execPath, ["-e", ""]);
        child.unref();
        return child;
      },
      () => undefined,
      { consumed: null, onGranted: () => undefined },
    );
    expect(admission.kind).toBe("ran");
    expect(callbackCalls).toBe(1);
    expect(observed.lock?.kind).toBe("held");
    expect(
      observed.lock?.kind === "held" &&
        observed.lock.holder.pid === process.pid,
    ).toBe(true);
  }

  it("a dead-parent proof with no nonce admits instead of refusing — the labelled orphan path", async () => {
    // The paired dead-parent direction for the negative above: once the
    // publisher is gone, the same (labelled, nonce=null) shape reads as
    // absent and falls through to ordinary admission rather than wedging on
    // the nonce mismatch on every service-manager retry.
    const hostHomeDir = await publishThenAge(0, LABEL);

    expect(await consumeHostStartAdoption("production", LABEL, null)).toEqual({
      kind: "absent",
    });
    await assertAdmitsOrdinarily(hostHomeDir, LABEL);
  });

  it("a FRESH proof with a LIVE parent bound to a different label still refuses — the label check is not skipped", async () => {
    // The other negative direction: moving the age bound ahead of the
    // label-binding check must not stop that check from firing for proofs that
    // are still live.
    expect(
      await publishAndConsumeWithLiveParent("ai.traycer.host.other", LABEL),
    ).toEqual({
      kind: "refused",
      reason: "host-start adoption is bound to a different service label",
    });
  });

  it("a dead-parent proof bound to a different label also admits, not refuses", async () => {
    // Ahead of the label-binding check is deliberate: whose grant a dead
    // parent's proof was is not a routing question for a launcher that never
    // held it - see `readOrphanedProof`.
    const hostHomeDir = await publishThenAge(0, "ai.traycer.host.other");

    expect(await consumeHostStartAdoption("production", LABEL, null)).toEqual({
      kind: "absent",
    });
    await assertAdmitsOrdinarily(hostHomeDir, LABEL);
  });

  // Production change B: the symmetric bound. `publishAgeAndConsumeWithLiveParent`
  // computes `issuedAtMs: Date.now() - ageMs`, so a NEGATIVE `ageMs` lands the
  // proof in the future - reused rather than duplicated, so a future-dated
  // fixture is guaranteed to differ from the past-dated ones above only in
  // sign. Same isolation as those: consumed INSIDE the contender's callback,
  // parent LIVE, so `Math.abs` - not `readOrphanedProof` - is what admits
  // here. `publishThenAge` (dead-parent by the time its caller consumes)
  // would let this pass even if `Math.abs` were dropped, for the same
  // reason the standalone future-dated test above did.
  it("a FUTURE-dated proof also admits on the labelled, nonce-less path — not just a past-dated one", async () => {
    const result = await publishAgeAndConsumeWithLiveParent(
      -(HOST_START_ADOPTION_MAX_AGE_MS + 1_000),
      LABEL,
      LABEL,
    );

    expect(result).toEqual({ kind: "absent" });
  });
});

describe("host-start adoption — origin plumbing (`host/lifecycle-origin.ts`)", () => {
  it("publishHostStartAdoption writes the origin field, and the resulting grant carries it through", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    await withUpdateContender(
      {
        hostHomeDir,
        reason: "host-start-adoption-origin-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "recovery-maintenance",
      },
      async (capability) => {
        await publishHostStartAdoption(
          capability,
          options(hostHomeDir),
          serviceLabel,
          "desktop",
        );
        const raw = JSON.parse(
          await readFile(
            join(hostHomeDir, ".host-start-adoption.json"),
            "utf8",
          ),
        ) as { readonly origin: string };
        expect(raw.origin).toBe("desktop");

        const nonce = await readAdoptionNonce(hostHomeDir);
        const consumed = await consumeHostStartAdoption(
          "production",
          serviceLabel,
          nonce,
        );
        expect(consumed.kind).toBe("grant");
        if (consumed.kind === "grant") {
          expect(consumed.grant.origin).toBe("desktop");
          await consumed.grant.abandon();
        }
      },
    );
  });

  it("a v2 proof hand-written WITHOUT an `origin` key still grants, with `grant.origin === null` (N-1 publisher)", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    await withUpdateContender(
      {
        hostHomeDir,
        reason: "host-start-adoption-missing-origin-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "recovery-maintenance",
      },
      async (capability) => {
        // Publish normally, then hand-rewrite the persisted proof with the
        // `origin` key stripped out entirely, simulating a publisher that
        // predates the field.
        await publishHostStartAdoption(
          capability,
          options(hostHomeDir),
          serviceLabel,
          "terminal",
        );
        const path = join(hostHomeDir, ".host-start-adoption.json");
        const proof = JSON.parse(await readFile(path, "utf8")) as Record<
          string,
          unknown
        >;
        delete proof.origin;
        await writeFile(path, JSON.stringify(proof), "utf8");

        const nonce = await readAdoptionNonce(hostHomeDir);
        const consumed = await consumeHostStartAdoption(
          "production",
          serviceLabel,
          nonce,
        );
        expect(consumed.kind).toBe("grant");
        if (consumed.kind === "grant") {
          expect(consumed.grant.origin).toBeNull();
          await consumed.grant.abandon();
        }
      },
    );
  });

  it("a v2 proof with an unknown `origin` string still grants, with `grant.origin === null`", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    await withUpdateContender(
      {
        hostHomeDir,
        reason: "host-start-adoption-garbage-origin-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "recovery-maintenance",
      },
      async (capability) => {
        await publishHostStartAdoption(
          capability,
          options(hostHomeDir),
          serviceLabel,
          "terminal",
        );
        const path = join(hostHomeDir, ".host-start-adoption.json");
        const proof = JSON.parse(await readFile(path, "utf8")) as Record<
          string,
          unknown
        >;
        proof.origin = "bogus";
        await writeFile(path, JSON.stringify(proof), "utf8");

        const nonce = await readAdoptionNonce(hostHomeDir);
        const consumed = await consumeHostStartAdoption(
          "production",
          serviceLabel,
          nonce,
        );
        expect(consumed.kind).toBe("grant");
        if (consumed.kind === "grant") {
          expect(consumed.grant.origin).toBeNull();
          await consumed.grant.abandon();
        }
      },
    );
  });
});
