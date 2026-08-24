import { describe, expect, it, vi } from "vitest";
import type { IncompatibilityUpgradeGuidance } from "@traycer/protocol/framework/index";
import {
  CLIENT_UPGRADE_HINT_FOR_SOURCE,
  clientCompatibilityRecoveryHint,
  clientCompatibilityRecoveryHintForVector,
  compatRecoveryHint,
  effectiveUpgradeGuidance,
  resolveCompatRecovery,
} from "../compat-recovery";
import type { ClientCompatibilityRequirement } from "@traycer/protocol/framework/index";
import {
  PACKAGE_MANAGER_UPGRADE_HINT,
  type CliInstallSource,
} from "../../manifest/cli-manifest";

// C2: a handshake `fatalError INCOMPATIBLE` must route to the correct
// per-vector recovery. `hostShouldUpgrade` reinstalls the latest host;
// `clientShouldUpgrade` updates THIS client via its install vector.

function guidance(
  hostShouldUpgrade: boolean,
  clientShouldUpgrade: boolean,
): IncompatibilityUpgradeGuidance {
  return { hostShouldUpgrade, clientShouldUpgrade };
}

describe("resolveCompatRecovery", () => {
  it("hostShouldUpgrade alone → reinstall host, no client upgrade", () => {
    const plan = resolveCompatRecovery(guidance(true, false), "manual");
    expect(plan.reinstallHost).toBe(true);
    expect(plan.clientUpgrade).toBeNull();
    expect(plan.summary).toContain("traycer host update");
  });

  it("clientShouldUpgrade is vector-aware per install source", () => {
    const sources: CliInstallSource[] = [
      "desktop",
      "manual",
      "homebrew",
      "winget",
      "scoop",
      "apt",
      "rpm",
    ];
    for (const source of sources) {
      const plan = resolveCompatRecovery(guidance(false, true), source);
      expect(plan.reinstallHost).toBe(false);
      expect(plan.clientUpgrade).not.toBeNull();
      expect(plan.clientUpgrade?.source).toBe(source);
      expect(plan.clientUpgrade?.hint).toBe(
        CLIENT_UPGRADE_HINT_FOR_SOURCE[source],
      );
      expect(plan.summary).toContain(CLIENT_UPGRADE_HINT_FOR_SOURCE[source]);
    }
  });

  it("homebrew client upgrade points at brew, not a package-manager-foreign command", () => {
    const plan = resolveCompatRecovery(guidance(false, true), "homebrew");
    expect(plan.clientUpgrade?.hint).toContain("brew upgrade");
    expect(plan.summary).toContain("brew upgrade");
  });

  it("mutual break asks to update both sides", () => {
    const plan = resolveCompatRecovery(guidance(true, true), "manual");
    expect(plan.reinstallHost).toBe(true);
    expect(plan.clientUpgrade).not.toBeNull();
    expect(plan.summary).toContain("traycer host update");
    expect(plan.summary).toContain(CLIENT_UPGRADE_HINT_FOR_SOURCE.manual);
  });

  it("null guidance (no verdict on the frame) → conservative restart-then-update", () => {
    const plan = resolveCompatRecovery(null, "manual");
    expect(plan.reinstallHost).toBe(false);
    expect(plan.clientUpgrade).toBeNull();
    expect(plan.summary).toContain("traycer host restart");
  });

  it("DOWNGRADE_UNSUPPORTED with null guidance normalizes to host-stale", () => {
    const normalized = effectiveUpgradeGuidance("DOWNGRADE_UNSUPPORTED", null);
    expect(normalized).toEqual(guidance(true, false));

    const plan = resolveCompatRecovery(normalized, "manual");
    expect(plan.reinstallHost).toBe(true);
    expect(plan.clientUpgrade).toBeNull();
    expect(plan.summary).toContain("traycer host update");
  });
});

describe("compatRecoveryHint", () => {
  it("distinguishes host-stale, client-stale, mutual, and unknown verdicts", () => {
    expect(compatRecoveryHint(guidance(true, false))).toContain(
      "host is out of date",
    );
    expect(compatRecoveryHint(guidance(false, true))).toContain(
      "this CLI is out of date",
    );
    expect(compatRecoveryHint(guidance(true, true))).toContain("both");
    expect(compatRecoveryHint(null)).toContain("host restart");
  });
});

describe("clientCompatibilityRecoveryHint", () => {
  function requirement(
    overrides: Partial<ClientCompatibilityRequirement>,
  ): ClientCompatibilityRequirement {
    return {
      minimumCompatibilityEpoch: 2,
      observedCompatibilityEpoch: 1,
      failure: "below-minimum",
      observedClientKind: "cli",
      observedClientAppVersion: "1.1.10",
      observedClientAppVersionStatus: "valid",
      minimumKnownClientAppVersion: null,
      upgradeChannel: null,
      hostReleaseChannel: "rc",
      ...overrides,
    };
  }

  it("states the generation gap and the generic CLI remedy, never a version or channel", () => {
    const hint = clientCompatibilityRecoveryHint(requirement({}));
    expect(hint).toContain("running 1.1.10");
    expect(hint).toContain("declares compatibility generation 1");
    expect(hint).toContain("while the host requires 2");
    expect(hint).toContain("Install the latest Traycer CLI");
    expect(hint).toContain(
      "Updating the host again will not help, and no data needs to be reset",
    );
    expect(hint).not.toContain("1.2.0");
    expect(hint).not.toContain("rc channel");
  });

  it("prints the host's unknown-version reading rather than inventing one", () => {
    expect(
      clientCompatibilityRecoveryHint(
        requirement({
          observedClientAppVersion: null,
          observedClientAppVersionStatus: "missing",
          observedCompatibilityEpoch: null,
        }),
      ),
    ).toContain("running an unknown version");
  });

  it("returns null when this was not an epoch rejection", () => {
    expect(clientCompatibilityRecoveryHint(null)).toBeNull();
  });
});

describe("clientCompatibilityRecoveryHintForVector", () => {
  function requirement(): ClientCompatibilityRequirement {
    return {
      minimumCompatibilityEpoch: 2,
      observedCompatibilityEpoch: 1,
      failure: "below-minimum",
      observedClientKind: "cli",
      observedClientAppVersion: "1.1.10",
      observedClientAppVersionStatus: "valid",
      minimumKnownClientAppVersion: null,
      upgradeChannel: null,
      hostReleaseChannel: "stable",
    };
  }

  it("manual + sufficient feed epoch names traycer cli upgrade", async () => {
    const readFeedEpoch = vi.fn(async () => 2);
    const hint = await clientCompatibilityRecoveryHintForVector({
      requirement: requirement(),
      source: "manual",
      readFeedEpoch,
    });
    expect(readFeedEpoch).toHaveBeenCalledTimes(1);
    expect(hint).toContain("traycer cli upgrade");
    expect(hint).toContain("generation 2");
  });

  it.each([
    ["insufficient", 1],
    ["absent", null],
  ] as const)(
    "manual + %s feed epoch names the releases page, not cli upgrade",
    async (_label, feedEpoch) => {
      const readFeedEpoch = vi.fn(async () => feedEpoch);
      const hint = await clientCompatibilityRecoveryHintForVector({
        requirement: requirement(),
        source: "manual",
        readFeedEpoch,
      });
      expect(readFeedEpoch).toHaveBeenCalledTimes(1);
      expect(hint).toContain("https://github.com/traycerai/traycer/releases");
      // The command may be NAMED here - it is ruled out explicitly, because it
      // is the obvious thing a blocked user reaches for and it would cost them
      // a wasted upgrade cycle. What must never appear is the IMPERATIVE form
      // the sufficient branch uses, which is the actual instruction.
      expect(hint).not.toMatch(/Run 'traycer cli upgrade'/u);
      expect(hint).toMatch(
        /could not verify that 'traycer cli upgrade' will resolve it/u,
      );
    },
  );

  it("manual + unreachable feed is the same as an unstamped one", async () => {
    const hint = await clientCompatibilityRecoveryHintForVector({
      requirement: requirement(),
      source: "manual",
      readFeedEpoch: async () => null,
    });
    expect(hint).toContain("https://github.com/traycerai/traycer/releases");
    expect(hint).not.toMatch(/Run 'traycer cli upgrade'/u);
    expect(hint).toMatch(
      /could not verify that 'traycer cli upgrade' will resolve it/u,
    );
  });

  it("bounds a stalled recovery-only feed lookup", async () => {
    vi.useFakeTimers();
    try {
      let recoverySignal: AbortSignal | undefined;
      const hintPromise = clientCompatibilityRecoveryHintForVector({
        requirement: requirement(),
        source: "manual",
        readFeedEpoch: (signal) => {
          recoverySignal = signal;
          return new Promise(() => undefined);
        },
      });
      await vi.advanceTimersByTimeAsync(3_000);
      const hint = await hintPromise;
      expect(hint).toContain("https://github.com/traycerai/traycer/releases");
      expect(recoverySignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(
    Object.keys(PACKAGE_MANAGER_UPGRADE_HINT) as Array<
      keyof typeof PACKAGE_MANAGER_UPGRADE_HINT
    >,
  )(
    "%s uses PACKAGE_MANAGER_UPGRADE_HINT and does not read the feed",
    async (source) => {
      const readFeedEpoch = vi.fn(async () => {
        throw new Error("feed must not be read for a package-manager vector");
      });
      const hint = await clientCompatibilityRecoveryHintForVector({
        requirement: requirement(),
        source,
        readFeedEpoch,
      });
      expect(readFeedEpoch).not.toHaveBeenCalled();
      expect(hint).toContain(PACKAGE_MANAGER_UPGRADE_HINT[source]);
      expect(hint).not.toMatch(/traycer cli upgrade/u);
    },
  );

  it("desktop uses its own hint and does not read the feed", async () => {
    const readFeedEpoch = vi.fn(async () => 2);
    const hint = await clientCompatibilityRecoveryHintForVector({
      requirement: requirement(),
      source: "desktop",
      readFeedEpoch,
    });
    expect(readFeedEpoch).not.toHaveBeenCalled();
    expect(hint).toContain(CLIENT_UPGRADE_HINT_FOR_SOURCE.desktop);
  });
});
