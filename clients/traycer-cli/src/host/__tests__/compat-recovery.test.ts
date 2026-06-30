import { describe, expect, it } from "vitest";
import type { IncompatibilityUpgradeGuidance } from "@traycer/protocol/framework/index";
import {
  CLIENT_UPGRADE_HINT_FOR_SOURCE,
  compatRecoveryHint,
  effectiveUpgradeGuidance,
  resolveCompatRecovery,
} from "../compat-recovery";
import type { CliInstallSource } from "../../manifest/cli-manifest";

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
