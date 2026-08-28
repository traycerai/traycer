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
} from "../host-start-adoption";

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
    const admission = await defaultRunHostStartDeps.admitHostStartSpawn(
      { environment: "production", cwd: null },
      async () => {
        callbackCalls += 1;
        const child = spawn(process.execPath, ["-e", ""]);
        child.unref();
        return child;
      },
    );
    expect(admission.kind).toBe("ran");
    expect(callbackCalls).toBe(1);
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

    await writeFile(
      adoptionPath,
      JSON.stringify({
        version: 1,
        issuedAtMs: Date.now() - 120_000,
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

  it("fails closed for a dangling canonical adoption symlink", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    const adoptionPath = join(hostHomeDir, ".host-start-adoption.json");
    await mkdir(hostHomeDir, { recursive: true });
    await symlink(join(hostHomeDir, "missing-proof.json"), adoptionPath);
    await expectPresentEntryNotAbsent();
  });

  it("fails closed after a deterministic canonical symlink replacement", async () => {
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
  });

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
        );
      },
    );
    const path = join(hostHomeDir, ".host-start-adoption.json");
    // Age the REAL proof rather than hand-rolling one, so every other field
    // stays exactly what the publisher wrote.
    const proof = JSON.parse(await readFile(path, "utf8")) as {
      issuedAtMs: number;
    };
    await writeFile(
      path,
      JSON.stringify({ ...proof, issuedAtMs: Date.now() - 120_000 }),
      "utf8",
    );

    expect(await consumeHostStartAdoption("production", null, null)).toEqual({
      kind: "absent",
    });
  });

  it("a FRESH proof still refuses a standalone start — the fail-closed arm is intact", async () => {
    // The paired direction. The age bound must not become a way to bypass the
    // grant: an outstanding, still-valid proof is reserved for the
    // service-labelled child, and letting a bare start through would recreate
    // the parent-lock/child-lock cycle the proof exists to avoid.
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
        );
      },
    );

    expect(await consumeHostStartAdoption("production", null, null)).toEqual({
      kind: "refused",
      reason: "host-start adoption is reserved for a service-labelled launch",
    });
  });

  // Production change B: `adoptionGrantExpired` became SYMMETRIC
  // (`Math.abs(now - issuedAtMs) > MAX_AGE`). Every test above only ever
  // ages a proof into the PAST, which the old asymmetric predicate already
  // handled — it does not exercise the actual fix. A FUTURE-dated
  // `issuedAtMs` (a backwards clock step, or a corrupted publisher stamp)
  // must read as expired too, exactly like a stale one, rather than reading
  // as an outstanding grant forever.
  it("a FUTURE-dated proof is ALSO treated as expired on the standalone path — the symmetric bound", async () => {
    const hostHomeDir = await freshHome();
    const serviceLabel = "ai.traycer.host.agent";
    homeRef.current = hostHomeDir;
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
        );
      },
    );
    const path = join(hostHomeDir, ".host-start-adoption.json");
    // Age the REAL proof INTO THE FUTURE rather than hand-rolling one, so
    // every other field stays exactly what the publisher wrote.
    const proof = JSON.parse(await readFile(path, "utf8")) as {
      issuedAtMs: number;
    };
    await writeFile(
      path,
      JSON.stringify({ ...proof, issuedAtMs: Date.now() + 10 * 60_000 }),
      "utf8",
    );

    expect(await consumeHostStartAdoption("production", null, null)).toEqual({
      kind: "absent",
    });
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
          JSON.stringify({ ...proof, issuedAtMs: Date.now() + 10 * 60_000 }),
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
        await publishHostStartAdoption(capability, options(hostHomeDir), label);
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

  it("an EXPIRED proof no longer refuses a labelled, nonce-less start", async () => {
    await publishThenAge(120_000, LABEL);

    expect(await consumeHostStartAdoption("production", LABEL, null)).toEqual({
      kind: "absent",
    });
  });

  it("an EXPIRED proof bound to a DIFFERENT label also admits, not refuses", async () => {
    // Why the bound is ordered ahead of the label-binding check: an expired
    // proof left by some other label would otherwise wedge THIS launcher with
    // "bound to a different service label" on every retry, which is the same
    // indefinite refusal wearing a different reason string.
    await publishThenAge(120_000, "ai.traycer.host.other");

    expect(await consumeHostStartAdoption("production", LABEL, null)).toEqual({
      kind: "absent",
    });
  });

  it("a FRESH proof still refuses a labelled start with NO nonce — the capability discipline is intact", async () => {
    // The load-bearing negative. The age bound must not become a way to launch
    // without presenting the nonce: while the grant is still live, a labelled
    // start that cannot produce the nonce is exactly the case the proof exists
    // to refuse. If this ever goes green alongside the first test, the fix has
    // turned into a nonce bypass.
    await publishThenAge(0, LABEL);

    expect(await consumeHostStartAdoption("production", LABEL, null)).toEqual({
      kind: "refused",
      reason:
        "host-start adoption nonce did not match the pending service launch",
    });
  });

  it("a FRESH proof bound to a different label still refuses — the label check is not skipped", async () => {
    // The other negative direction: moving the age bound ahead of the
    // label-binding check must not stop that check from firing for proofs that
    // are still live.
    await publishThenAge(0, "ai.traycer.host.other");

    expect(await consumeHostStartAdoption("production", LABEL, null)).toEqual({
      kind: "refused",
      reason: "host-start adoption is bound to a different service label",
    });
  });

  // Production change B: the symmetric bound. `publishThenAge` computes
  // `issuedAtMs: Date.now() - ageMs`, so a NEGATIVE `ageMs` lands the proof
  // in the future - reused rather than duplicated, so a future-dated fixture
  // is guaranteed to differ from the past-dated ones above only in sign.
  it("a FUTURE-dated proof also admits on the labelled, nonce-less path — not just a past-dated one", async () => {
    // `publishThenAge` only rewrites `issuedAtMs` for `ageMs > 0` (it is a
    // past-dating helper), so a future date needs its own write rather than
    // a negative `ageMs` reuse.
    const hostHomeDir = await publishThenAge(0, LABEL);
    const path = join(hostHomeDir, ".host-start-adoption.json");
    const proof = JSON.parse(await readFile(path, "utf8")) as {
      issuedAtMs: number;
    };
    await writeFile(
      path,
      JSON.stringify({ ...proof, issuedAtMs: Date.now() + 10 * 60_000 }),
      "utf8",
    );

    expect(await consumeHostStartAdoption("production", LABEL, null)).toEqual({
      kind: "absent",
    });
  });
});
