import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  COMPATIBILITY_FLOOR_UNPINNED,
  FIRST_LOCK_AWARE_RELEASE,
  HOST_START_STAMP_FLOOR,
  HOST_START_STAMP_PROVEN_FLOOR,
  HOST_START_STAMP_WRITER_FLOOR,
  LOCK_AWARE_CLI_FLOOR,
  LOCK_AWARE_DESKTOP_FLOOR,
  SHIPPED_COMPATIBILITY_FLOORS,
  decideCompatibilityFence,
  decideLegacyMarkerConcurrency,
  resolveCohortPolicy,
  type CompatibilityFloors,
} from "../compatibility-fence";
import {
  LOCAL_BUILD_VERSION,
  nonReleaseIdentityKind,
} from "../../host-version/non-release-identity";
import { compareHostVersions } from "../../host-version/compare-host-versions";

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
    expect(FIRST_LOCK_AWARE_RELEASE).not.toBe(COMPATIBILITY_FLOOR_UNPINNED);
    expect(SHIPPED_COMPATIBILITY_FLOORS).toEqual({
      cli: FIRST_LOCK_AWARE_RELEASE,
      desktop: FIRST_LOCK_AWARE_RELEASE,
    });
  });

  it("the host STAMP floor is NOT the lock floor, and is strictly lower", () => {
    // The whole reason this is a third name rather than a reuse. The two
    // floor different properties in different repositories, and the evidence
    // (Q14) put them two minor lines apart: the writer that stamps `pid.json`
    // landed at host-v1.1.9, lock-awareness at 1.3.0-rc.1. A fence that had
    // reused the CLI floor here would force version-only verification on
    // every 1.1.9 - 1.3.0 host that could in fact prove its identity.
    expect(HOST_START_STAMP_FLOOR).not.toBe(FIRST_LOCK_AWARE_RELEASE);
    expect(
      compareHostVersions(HOST_START_STAMP_FLOOR, FIRST_LOCK_AWARE_RELEASE),
    ).toEqual({ comparable: true, ordering: "less" });
  });

  it.each([
    // The readings the floor is derived from, as an ordering matrix. These are
    // raw `pid.json` observations on BOTH platforms, not the reader's verdict.
    // 1.1.11 is EQUAL because the shipped floor is the proven line itself.
    ["1.0.0", "less"],
    ["1.1.5", "less"],
    ["1.1.8", "less"],
    ["1.1.11", "equal"],
    ["1.2.0", "greater"],
    ["1.3.0-rc.3", "greater"],
  ] as const)(
    "orders the observed host %s against the stamp floor as %s",
    (version, ordering) => {
      expect(compareHostVersions(version, HOST_START_STAMP_FLOOR)).toEqual({
        comparable: true,
        ordering,
      });
    },
  );

  it("the SHIPPED stamp floor is never BELOW the proven one", () => {
    // The load-bearing invariant, and the reason the shipped value is the
    // higher of the two candidates. A floor under the proven line claims a
    // version stamps when nobody has observed it doing so, and that claim
    // fails in the Q1 direction: mandatory identity verification against a
    // host that cannot supply an identity, which is a hard failure on every
    // rollback into the band rather than a recorded degradation.
    //
    // Written as "not less" rather than "equal" on purpose - the two are equal
    // today and must be allowed to diverge upward when a later reading proves
    // a higher line, but never downward.
    const shippedVsProven = compareHostVersions(
      HOST_START_STAMP_FLOOR,
      HOST_START_STAMP_PROVEN_FLOOR,
    );
    // Incomparable is a failure too: two floors that cannot be ordered cannot
    // satisfy an invariant about their order.
    expect(shippedVsProven.comparable).toBe(true);
    if (!shippedVsProven.comparable) return;
    expect(shippedVsProven.ordering).not.toBe("less");
  });

  it("the writer-history floor is BELOW the shipped one - it is evidence, not a floor", () => {
    // Source history says a version CAN write the stamp; a raw reading says
    // one DID. Between them sit failure modes source cannot see, so the
    // writer's first tag is deliberately not shipped. When the 1.1.9/1.1.10
    // rows land and prove it, this becomes the floor and the two converge.
    expect(HOST_START_STAMP_WRITER_FLOOR).toBe("1.1.9");
    expect(
      compareHostVersions(
        HOST_START_STAMP_WRITER_FLOOR,
        HOST_START_STAMP_FLOOR,
      ),
    ).toEqual({ comparable: true, ordering: "less" });
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
    ).toEqual({ kind: "admit", waived: [] });
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

describe("compatibility fence — non-release build identities", () => {
  const LOCAL_INSTALL = "local-traycer-host.tar.gz-2026-09-07T19-30-00-000Z";
  const STAGING = "staging.1783550586518.bb8c937d9";

  // REAL identities this round produced, not invented ones. The authority for
  // this shape is the staging build pipeline, which is outside this repository
  // - so a drift there would refuse every staging build with nothing here
  // reddening, and the fence's own matrix runs on staging builds. Pinning
  // strings the pipeline actually emitted moves that failure into this suite.
  // Supplied by reviewer C from the final-round Mac staging slot and the Q7
  // patch's unorderable-install fixture.
  const REAL_STAGING_IDENTITIES = [
    "staging.1788780730120.1d4be2fe71",
    "staging.1788716277681.312db41da0",
  ] as const;

  it.each([
    // TWO BRANCHES, not one, and this is the whole finding. A rule that only
    // handles "incomparable" identities covers the first two rows and misses
    // the third entirely, because `0.0.0-local` IS valid SemVer and sorts
    // below every release - so it lands on `cli-below-floor`, a different arm.
    // A dev CLI would then be refused by a fence that believed it had handled
    // dev builds.
    ["staging build (incomparable)", STAGING, "staging-build"],
    ["local install (incomparable)", LOCAL_INSTALL, "local-install"],
    [
      "unreleased build (comparable, BELOW the floor)",
      "0.0.0-local",
      "local-build",
    ],
  ] as const)(
    "admits a %s CLI with a recorded waiver rather than refusing it",
    (_label, installedCliVersion, identity) => {
      expect(
        decideCompatibilityFence(
          { installedCliVersion, desktopVersion: "1.4.2" },
          SHIPPED_COMPATIBILITY_FLOORS,
        ),
      ).toEqual({
        kind: "admit",
        waived: [{ actor: "cli", version: installedCliVersion, identity }],
      });
    },
  );

  it.each([
    ["staging build (incomparable)", STAGING, "staging-build"],
    [
      "unreleased build (comparable, BELOW the floor)",
      "0.0.0-local",
      "local-build",
    ],
  ] as const)(
    "admits a %s DESKTOP with a recorded waiver - the matrix's own builds run here",
    (_label, desktopVersion, identity) => {
      expect(
        decideCompatibilityFence(
          { installedCliVersion: "1.4.2", desktopVersion },
          SHIPPED_COMPATIBILITY_FLOORS,
        ),
      ).toEqual({
        kind: "admit",
        waived: [{ actor: "desktop", version: desktopVersion, identity }],
      });
    },
  );

  it("records BOTH actors when both are non-release, in desktop-then-cli order", () => {
    expect(
      decideCompatibilityFence(
        { installedCliVersion: "0.0.0-local", desktopVersion: STAGING },
        SHIPPED_COMPATIBILITY_FLOORS,
      ),
    ).toEqual({
      kind: "admit",
      waived: [
        { actor: "desktop", version: STAGING, identity: "staging-build" },
        { actor: "cli", version: "0.0.0-local", identity: "local-build" },
      ],
    });
  });

  it("a fully released pair is admitted with an EMPTY waiver list, never a missing one", () => {
    // The waiver is recorded positively on every admit, so "nothing was
    // waived" and "nobody looked" are different values rather than the same
    // absence. Same rule Ticket 07's `verification` key settled on.
    const verdict = decideCompatibilityFence(
      { installedCliVersion: "1.4.2", desktopVersion: "1.4.2" },
      SHIPPED_COMPATIBILITY_FLOORS,
    );
    expect(verdict).toEqual({ kind: "admit", waived: [] });
    if (verdict.kind !== "admit") return;
    expect(Array.isArray(verdict.waived)).toBe(true);
  });

  it.each([
    // MALFORMED IS NOT A DEV BUILD. The waiver is an enumerated recognizer,
    // not "anything unparseable" - these are evidence of corruption or a typo
    // and must keep refusing, or a truncated version string becomes the way to
    // disable the fence.
    ["banana"],
    ["1.2"],
    [""],
    ["staging"],
    ["staging.notanepoch.abc1234"],
    ["local-dev"],
    ["local-"],
  ] as const)(
    "still refuses the malformed identity '%s' rather than waiving it",
    (installedCliVersion) => {
      expect(
        decideCompatibilityFence(
          { installedCliVersion, desktopVersion: "1.4.2" },
          SHIPPED_COMPATIBILITY_FLOORS,
        ),
      ).toEqual({ kind: "refuse", reason: "cli-version-incomparable" });
    },
  );

  it("a NEAR MISS of the dev string is refused as below-floor, not waived - the by-name exemption cannot widen", () => {
    // `0.0.0-locale` is valid SemVer and sorts below the floor, so it does not
    // even reach the incomparable arm. It is the exact shape a by-name
    // exemption is meant to keep out: a real version that merely looks like
    // the dev one. Refused as below-floor, which is the honest answer.
    expect(
      decideCompatibilityFence(
        { installedCliVersion: "0.0.0-locale", desktopVersion: "1.4.2" },
        SHIPPED_COMPATIBILITY_FLOORS,
      ),
    ).toEqual({ kind: "refuse", reason: "cli-below-floor" });
    expect(nonReleaseIdentityKind("0.0.0-locale")).toBeNull();
  });

  it.each(REAL_STAGING_IDENTITIES)(
    "recognises the real staging identity %s the pipeline actually emitted",
    (identity) => {
      expect(nonReleaseIdentityKind(identity)).toBe("staging-build");
      expect(
        decideCompatibilityFence(
          { installedCliVersion: null, desktopVersion: identity },
          SHIPPED_COMPATIBILITY_FLOORS,
        ),
      ).toEqual({
        kind: "admit",
        waived: [
          { actor: "desktop", version: identity, identity: "staging-build" },
        ],
      });
    },
  );

  it("the local-build waiver names the SAME string evaluateHostClientFloor exempts", () => {
    // `evaluateHostClientFloor` exempts `LOCAL_CLI_VERSION` BY NAME so the
    // exemption "cannot widen". The fence needs the identical string or a dev
    // build passes one policy and fails the other, which is worse than either
    // answer alone. One definition, imported by both.
    expect(LOCAL_BUILD_VERSION).toBe("0.0.0-local");
    expect(nonReleaseIdentityKind(LOCAL_BUILD_VERSION)).toBe("local-build");
  });
});

describe("compatibility fence — the preventive matrix, floors pinned", () => {
  it("admits a fully lock-aware machine", () => {
    expect(
      decideCompatibilityFence(
        { installedCliVersion: "1.3.0", desktopVersion: "1.3.0" },
        PINNED,
      ),
    ).toEqual({ kind: "admit", waived: [] });
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
    ).toEqual({ kind: "admit", waived: [] });
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
    ).toEqual({ kind: "admit", waived: [] });
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

describe("compatibility fence — the call-site contract", () => {
  // The cutover's HARD CONSTRAINT is that the fence must not refuse the
  // upgrade path itself: the E8v rows are pre-cutover CLIs updating to the
  // flipped release, on machines with no Desktop. That holds by CONSTRUCTION
  // rather than by any verdict - those machines never reach the fence, because
  // its only production call site is Desktop's activation admission.
  //
  // Which makes the constraint rest on a structural claim that nothing pinned:
  // add a CLI-side call site and the hard constraint breaks with every fence
  // test still green. This matches the call-site LIST, not a count, so a
  // replacement fails too. (Reviewer C, Q8 review, mirroring the GUI side's
  // `LocalUpdateClock` contract test.)
  const ALLOWED_CALL_SITES = [
    "clients/desktop/src/electron-main/host/update-executor.ts",
  ] as const;

  it("decideCompatibilityFence is called from Desktop's admission and nowhere else in production", async () => {
    const repoRoot = resolve(__dirname, "../../../..");
    const { stdout } = await promisify(execFile)(
      "git",
      ["grep", "-l", "decideCompatibilityFence(", "--", "clients", "protocol"],
      { cwd: repoRoot },
    );

    const callSites = stdout
      .split("\n")
      .filter((line) => line.length > 0)
      // The definition, the barrel that re-exports it, and test files are not
      // call sites. Everything else is.
      .filter(
        (file) =>
          !file.endsWith("host-update/compatibility-fence.ts") &&
          !file.endsWith("host-update/index.ts") &&
          !file.includes("__tests__/") &&
          !file.endsWith(".test.ts"),
      )
      .sort();

    expect(callSites).toEqual([...ALLOWED_CALL_SITES]);
  });
});
