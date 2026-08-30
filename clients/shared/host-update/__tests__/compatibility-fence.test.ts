import { describe, expect, it } from "vitest";
import {
  COMPATIBILITY_FLOOR_UNPINNED,
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
  it("both floors ship UNPINNED, and the fence refuses while they are", () => {
    // This pins the deviation from the plan's "land with the current dev
    // version" wording, and the reason for it. A dev version is BELOW every
    // real release, so an unpinned floor would admit the whole fleet including
    // the lock-blind binaries the fence exists to refuse - and forgetting the
    // re-pin would be silent and fleet-wide. Refusing instead makes that
    // mistake loud.
    expect(LOCK_AWARE_CLI_FLOOR).toBe(COMPATIBILITY_FLOOR_UNPINNED);
    expect(LOCK_AWARE_DESKTOP_FLOOR).toBe(COMPATIBILITY_FLOOR_UNPINNED);
    expect(
      decideCompatibilityFence(
        { installedCliVersion: "9.9.9", desktopVersion: "9.9.9" },
        SHIPPED_COMPATIBILITY_FLOORS,
      ),
    ).toEqual({ kind: "refuse", reason: "floor-unpinned" });
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
