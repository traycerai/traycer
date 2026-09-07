import { describe, expect, it } from "vitest";
import {
  COMPATIBILITY_FLOOR_UNPINNED,
  FIRST_LOCK_AWARE_RELEASE,
  HOST_START_STAMP_FLOOR,
  LOCK_AWARE_CLI_FLOOR,
  LOCK_AWARE_DESKTOP_FLOOR,
  SHIPPED_COMPATIBILITY_FLOORS,
  decideCompatibilityFence,
  decideLegacyMarkerConcurrency,
  resolveCohortPolicy,
  type CompatibilityFloors,
} from "../compatibility-fence";

// Direct unit suite for Ticket 07's compatibility fence.

/** Pinned floors, so the matrix below exercises real ordering. */
const PINNED: CompatibilityFloors = { cli: "1.3.0", desktop: "1.3.0" };

describe("compatibility fence — the SHIPPED floors", () => {
  it("every floor is PINNED to the one derived release, and no floor still carries the sentinel", () => {
    // The re-pin the sentinel's docblock demanded. One number, three names:
    // CLI, Desktop and the host start-stamp floor Ticket 07's verify leg
    // reads. Asserting each against the shared constant rather than against a
    // literal is deliberate - a literal here would be a fourth place the
    // number lives, which is the thing this shape exists to prevent.
    expect(LOCK_AWARE_CLI_FLOOR).toBe(FIRST_LOCK_AWARE_RELEASE);
    expect(LOCK_AWARE_DESKTOP_FLOOR).toBe(FIRST_LOCK_AWARE_RELEASE);
    expect(HOST_START_STAMP_FLOOR).toBe(FIRST_LOCK_AWARE_RELEASE);
    expect(FIRST_LOCK_AWARE_RELEASE).not.toBe(COMPATIBILITY_FLOOR_UNPINNED);
    expect(SHIPPED_COMPATIBILITY_FLOORS).toEqual({
      cli: FIRST_LOCK_AWARE_RELEASE,
      desktop: FIRST_LOCK_AWARE_RELEASE,
    });
  });

  it("admits a machine at the shipped floors rather than refusing floor-unpinned", () => {
    // The half of the sequencing caveat this commit is responsible for.
    // Pinning while `decideCompatibilityFence` stays unwired changes nothing
    // observable; wiring it while a floor held the sentinel would refuse
    // EVERYTHING. This asserts the shipped floors no longer produce that
    // verdict, so the wiring commit lands on floors that can admit.
    expect(
      decideCompatibilityFence(
        { installedCliVersion: "9.9.9", desktopVersion: "9.9.9" },
        SHIPPED_COMPATIBILITY_FLOORS,
      ),
    ).toEqual({ kind: "admit" });
  });

  it("the sentinel still refuses first when a NEWLY added floor carries it", () => {
    // The fail-closed property is not retired by the re-pin - it is what any
    // floor added later inherits before somebody derives its number.
    expect(
      decideCompatibilityFence(
        { installedCliVersion: "9.9.9", desktopVersion: "9.9.9" },
        {
          cli: COMPATIBILITY_FLOOR_UNPINNED,
          desktop: FIRST_LOCK_AWARE_RELEASE,
        },
      ),
    ).toEqual({ kind: "refuse", reason: "floor-unpinned" });
  });

  it.each([
    // The whole point of pinning at the rc rather than at 1.3.0: rc.1/2/3 all
    // ship the lock protocol, so a `1.3.0` floor would refuse three lock-aware
    // releases. Prereleases sort below their release, which is what makes the
    // rc pin admit them.
    ["1.3.0-rc.1", "admit"],
    ["1.3.0-rc.2", "admit"],
    ["1.3.0-rc.3", "admit"],
    ["1.3.0", "admit"],
    ["1.4.2", "admit"],
    // Every pre-cutover line the audit enumerates. These are the lock-blind
    // binaries the fence exists for.
    ["1.2.0", "refuse"],
    ["1.1.11", "refuse"],
    ["1.1.8", "refuse"],
    ["1.1.5", "refuse"],
    ["1.0.0", "refuse"],
  ] as const)(
    "orders a %s CLI against the shipped floor as %s",
    (installedCliVersion, expected) => {
      const verdict = decideCompatibilityFence(
        { installedCliVersion, desktopVersion: "1.4.2" },
        SHIPPED_COMPATIBILITY_FLOORS,
      );
      expect(verdict.kind).toBe(expected);
      if (verdict.kind === "refuse") {
        expect(verdict.reason).toBe("cli-below-floor");
      }
    },
  );

  it("a 1.3.0 floor would have refused the three lock-aware rcs - the counterfactual the rc pin exists to avoid", () => {
    // Stated as a test rather than a comment so the reason for the rc suffix
    // cannot be optimised away by someone "tidying" the floor to 1.3.0.
    for (const rc of ["1.3.0-rc.1", "1.3.0-rc.2", "1.3.0-rc.3"]) {
      expect(
        decideCompatibilityFence(
          { installedCliVersion: rc, desktopVersion: "1.4.2" },
          { cli: "1.3.0", desktop: "1.3.0" },
        ),
      ).toEqual({ kind: "refuse", reason: "cli-below-floor" });
    }
  });

  it("an unpinned floor refuses even a fleet that would otherwise pass", () => {
    // The ordering inside the function matters: the unpinned check has to come
    // FIRST, because every comparison after it is meaningless against a
    // sentinel. If it ran last, a high-enough version pair would be admitted
    // against a floor nobody had set.
    expect(
      decideCompatibilityFence(
        { installedCliVersion: "1.3.0", desktopVersion: "1.3.0" },
        { cli: "1.3.0", desktop: COMPATIBILITY_FLOOR_UNPINNED },
      ),
    ).toEqual({ kind: "refuse", reason: "floor-unpinned" });
  });
});

describe("compatibility fence — the preventive matrix, floors pinned", () => {
  it("admits a fully lock-aware machine", () => {
    expect(
      decideCompatibilityFence(
        { installedCliVersion: "1.3.0", desktopVersion: "1.3.0" },
        PINNED,
      ),
    ).toEqual({ kind: "admit" });
  });

  it("refuses an installed CLI below the floor", () => {
    expect(
      decideCompatibilityFence(
        { installedCliVersion: "1.2.9", desktopVersion: "1.3.0" },
        PINNED,
      ),
    ).toEqual({ kind: "refuse", reason: "cli-below-floor" });
  });

  it("refuses a Desktop below the floor", () => {
    expect(
      decideCompatibilityFence(
        { installedCliVersion: "1.3.0", desktopVersion: "1.2.9" },
        PINNED,
      ),
    ).toEqual({ kind: "refuse", reason: "desktop-below-floor" });
  });

  it("ADMITS when no CLI is recorded — the named residual, asserted so it is a decision", () => {
    // Deliberately not a refusal. This signal detects an old INSTALLED CLI and
    // is structurally silent on one invoked from elsewhere on `PATH`. Refusing
    // on absence would not close that gap; it would only refuse machines with
    // no installed CLI, which are not the dangerous ones. The `PATH` case is
    // detective-only and retired solely by the floor rising.
    expect(
      decideCompatibilityFence(
        { installedCliVersion: null, desktopVersion: "1.3.0" },
        PINNED,
      ),
    ).toEqual({ kind: "admit" });
  });

  it.each([
    [
      "cli",
      { installedCliVersion: "local-dev", desktopVersion: "1.3.0" },
      "cli-version-incomparable",
    ],
    [
      "desktop",
      { installedCliVersion: "1.3.0", desktopVersion: "local-dev" },
      "desktop-version-incomparable",
    ],
  ] as const)(
    "refuses an incomparable %s version rather than waiving it",
    (_which, input, reason) => {
      // "Cannot compare" is not evidence of compliance. The fence exists
      // because an unverified actor is the dangerous one, so an unorderable
      // version is exactly the case that must not be admitted.
      expect(decideCompatibilityFence(input, PINNED)).toEqual({
        kind: "refuse",
        reason,
      });
    },
  );

  it("an equal version is admitted — the floor is a minimum, not an exclusive bound", () => {
    expect(
      decideCompatibilityFence(
        { installedCliVersion: "1.3.0", desktopVersion: "1.3.0" },
        { cli: "1.3.0", desktop: "1.3.0" },
      ),
    ).toEqual({ kind: "admit" });
    // Stated separately because off-by-one on a floor is silent: a strict
    // `>` would refuse the very release that introduced lock-awareness.
    expect(
      decideCompatibilityFence(
        { installedCliVersion: "1.3.0-rc.1", desktopVersion: "1.3.0" },
        { cli: "1.3.0", desktop: "1.3.0" },
      ),
    ).toEqual({ kind: "refuse", reason: "cli-below-floor" });
  });
});

describe("compatibility fence — the detective half", () => {
  it("is clear when no legacy marker is present", () => {
    expect(
      decideLegacyMarkerConcurrency({
        legacyMarkerPresent: false,
        attemptPhase: "applying",
      }),
    ).toEqual({ kind: "clear" });
  });

  it("is clear when a marker exists but no attempt is live", () => {
    // A marker alone is a legacy update running by itself - the pre-cutover
    // world working normally. Nothing was mixed, so there is nothing to abort.
    expect(
      decideLegacyMarkerConcurrency({
        legacyMarkerPresent: true,
        attemptPhase: null,
      }),
    ).toEqual({ kind: "clear" });
  });

  it.each([
    "downloading",
    "preparing",
    "applying",
    "waiting-to-activate",
  ] as const)(
    "parks a pre-tombstone attempt (%s) — the record can still be resumed",
    (phase) => {
      const verdict = decideLegacyMarkerConcurrency({
        legacyMarkerPresent: true,
        attemptPhase: phase,
      });
      expect(verdict.kind).toBe("abort");
      if (verdict.kind !== "abort") return;
      expect(verdict.disposition).toBe("park");
      // The diagnostic must NAME the evidence. An abort whose cause is not on
      // the record is a mystery to whoever finds the parked attempt later.
      expect(verdict.diagnostic).toContain("update-progress.json");
      expect(verdict.diagnostic).toContain(phase);
    },
  );

  it.each(["restarting", "verifying"] as const)(
    "TERMINALIZES a post-tombstone attempt (%s) — the graph offers no park",
    (phase) => {
      // Not a severity choice. Once `restarting` is committed the record has
      // promised a return and the graph offers {verifying, failed, superseded}
      // and no park at all, so terminal-with-diagnostics is the only honest
      // close. Same law as the amended F3 ruling, different trigger.
      const verdict = decideLegacyMarkerConcurrency({
        legacyMarkerPresent: true,
        attemptPhase: phase,
      });
      expect(verdict.kind).toBe("abort");
      if (verdict.kind !== "abort") return;
      expect(verdict.disposition).toBe("terminalize");
      expect(verdict.diagnostic).toContain(phase);
    },
  );

  it.each(["complete", "failed", "superseded"] as const)(
    "is clear for a TERMINAL attempt phase (%s) — history beside a legacy marker is not concurrency",
    (phase) => {
      // A terminal record (complete/failed/superseded) has no legal
      // successors, so an abort/park disposition would be unapplyable. This
      // is distinct from the post-tombstone (`restarting`/`verifying`) case
      // above, which still aborts: those phases are live and non-terminal,
      // only barred from parking.
      expect(
        decideLegacyMarkerConcurrency({
          legacyMarkerPresent: true,
          attemptPhase: phase,
        }),
      ).toEqual({ kind: "clear" });
    },
  );
});

describe("cohort policy (O4) — failure degrades TO the fence, never through it", () => {
  it("uses a verified, fresh remote policy", () => {
    expect(
      resolveCohortPolicy(
        { enabled: true, signatureVerified: true, stale: false },
        false,
      ),
    ).toEqual({ enabled: true, source: "remote-list" });
  });

  it.each([
    ["absent", null],
    ["unverified", { enabled: true, signatureVerified: false, stale: false }],
    ["stale", { enabled: true, signatureVerified: true, stale: true }],
  ] as const)("falls back to the static default when %s", (_label, policy) => {
    // The load-bearing property, and the reason all three share one branch: a
    // kill switch whose failure mode is "admit" is not a kill switch. Each of
    // these carries `enabled: true`, so a fallback that leaked the remote
    // value would return `true` here and look perfectly healthy.
    expect(resolveCohortPolicy(policy, false)).toEqual({
      enabled: false,
      source: "static-default",
    });
  });

  it("the static default is honoured in BOTH directions, so the test is not passing on a constant", () => {
    expect(resolveCohortPolicy(null, true)).toEqual({
      enabled: true,
      source: "static-default",
    });
  });
});
