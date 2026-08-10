import { describe, expect, it } from "vitest";
import type {
  ProviderManagedVersions,
  ProviderPackVersion,
} from "@traycer/protocol/host/provider-schemas";
import {
  certificationBadgeLabel,
  comparePackVersionsDescending,
  composeVersionRowMeta,
  findRecommendedVersion,
  formatPackSizeBytes,
  installPackVersionRefusalMessage,
  isVersionBelowBaseline,
  unusableReasonLabel,
  updateBannerDownloadEligibility,
  packVersionUseRefusalMessage,
  versionDeleteEligibility,
  versionDownloadEligibility,
  versionErrorIsRetryable,
  versionShowsInstallFetchAction,
  versionUseEligibility,
} from "@/components/settings/panels/provider-pack-version-manager-model";

function version(
  partial: Partial<ProviderPackVersion> & Pick<ProviderPackVersion, "version">,
): ProviderPackVersion {
  return {
    sizeBytes: 40_000_000,
    certification: "eligible",
    recommended: false,
    current: false,
    installState: { status: "installed" },
    ...partial,
  };
}

function managed(
  available: readonly ProviderPackVersion[],
): ProviderManagedVersions {
  return {
    autoDownload: true,
    pinnedVersion: null,
    updateAvailable: null,
    sharedWithProviders: [],
    totalSizeBytes: 40_000_000,
    available: [...available],
  };
}

function errorState(
  reason: string,
): Extract<ProviderPackVersion["installState"], { status: "error" }> {
  return {
    status: "error",
    reason: reason as "network",
    message: reason,
    retryAtMs: null,
  };
}

describe("versionUseEligibility", () => {
  it("disables Use when installed version is below the recommended baseline", () => {
    const row = version({
      version: "1.0.0",
      installState: { status: "installed" },
    });
    const result = versionUseEligibility(row, "1.2.0");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason.toLowerCase()).toContain("baseline");
    }
  });

  it("allows Use when installed version is above the recommended baseline and not current", () => {
    const row = version({
      version: "1.3.0",
      installState: { status: "installed" },
    });
    expect(versionUseEligibility(row, "1.2.0")).toEqual({ allowed: true });
  });

  it("allows Use when installed version equals the recommended baseline and not current", () => {
    const row = version({
      version: "1.2.0",
      recommended: true,
      installState: { status: "installed" },
    });
    expect(versionUseEligibility(row, "1.2.0")).toEqual({ allowed: true });
  });

  it("disables Use for the current installed version", () => {
    const row = version({
      version: "1.2.0",
      current: true,
      installState: { status: "installed" },
    });
    const result = versionUseEligibility(row, "1.2.0");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason.toLowerCase()).toMatch(/already current|current/);
    }
  });

  it("allows Use for installed yanked when not current and not below recommended", () => {
    // Yanked certification does not block Use in the model once installed.
    const row = version({
      version: "1.3.0",
      certification: "yanked",
      installState: { status: "installed" },
    });
    expect(versionUseEligibility(row, "1.2.0")).toEqual({ allowed: true });
  });

  it("disables Use for a prerelease below the stable recommended baseline (D1)", () => {
    const row = version({
      version: "1.2.3-beta.1",
      installState: { status: "installed" },
    });
    const result = versionUseEligibility(row, "1.2.3");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason.toLowerCase()).toContain("baseline");
    }
  });

  it("fails closed when the shipped baseline is unknown (offline / no recommended row)", () => {
    // Integration finding 1: honest offline shape with no recommended row
    // must not optimistically allow Use.
    const row = version({
      version: "1.0.0",
      installState: { status: "installed" },
    });
    const result = versionUseEligibility(row, null);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason.toLowerCase()).toMatch(/baseline|reconnect/);
    }
  });
});

describe("versionDeleteEligibility", () => {
  it("does not allow Delete for the current version", () => {
    const row = version({
      version: "1.2.0",
      current: true,
      installState: { status: "installed" },
    });
    const result = versionDeleteEligibility(row);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason.toLowerCase()).toMatch(/switch|first/);
    }
  });

  it("allows Delete for a non-current installed version", () => {
    const row = version({
      version: "1.1.0",
      current: false,
      installState: { status: "installed" },
    });
    expect(versionDeleteEligibility(row)).toEqual({ allowed: true });
  });
});

describe("versionDownloadEligibility", () => {
  it("rejects yanked, below-security-floor, and host-ineligible even when absent", () => {
    expect(
      versionDownloadEligibility(
        version({
          version: "1.0.0",
          certification: "yanked",
          installState: { status: "absent" },
        }),
      ).allowed,
    ).toBe(false);
    expect(
      versionDownloadEligibility(
        version({
          version: "1.0.0",
          certification: "below-security-floor",
          installState: { status: "absent" },
        }),
      ).allowed,
    ).toBe(false);
    expect(
      versionDownloadEligibility(
        version({
          version: "1.0.0",
          certification: "host-ineligible",
          installState: { status: "absent" },
        }),
      ).allowed,
    ).toBe(false);
  });

  it("allows download for eligible + absent", () => {
    expect(
      versionDownloadEligibility(
        version({
          version: "1.4.0",
          certification: "eligible",
          installState: { status: "absent" },
        }),
      ),
    ).toEqual({ allowed: true });
  });

  it("keeps installed yanked not downloadable but still deletable when not current", () => {
    const row = version({
      version: "1.1.0",
      certification: "yanked",
      current: false,
      installState: { status: "installed" },
    });
    expect(versionDownloadEligibility(row).allowed).toBe(false);
    expect(versionDeleteEligibility(row)).toEqual({ allowed: true });
  });

  it("keeps installed uncertified not re-downloadable but still deletable when not current", () => {
    const row = version({
      version: "1.1.0",
      certification: "uncertified",
      current: false,
      installState: { status: "installed" },
    });
    expect(versionDownloadEligibility(row).allowed).toBe(false);
    expect(versionDeleteEligibility(row)).toEqual({ allowed: true });
  });

  it("denies download for non-retryable error reasons (trust-unavailable, local-storage-mismatch, unrepairable)", () => {
    for (const reason of [
      "trust-unavailable",
      "local-storage-mismatch",
      "unrepairable",
    ] as const) {
      const row = version({
        version: "1.0.0",
        installState: errorState(reason),
      });
      expect(versionDownloadEligibility(row).allowed).toBe(false);
      expect(versionShowsInstallFetchAction(row)).toBe(false);
      expect(versionErrorIsRetryable(row.installState)).toBe(false);
    }
  });

  it("allows download/retry only for allow-listed error reasons", () => {
    const row = version({
      version: "1.0.0",
      installState: errorState("network"),
    });
    expect(versionDownloadEligibility(row).allowed).toBe(true);
    expect(versionShowsInstallFetchAction(row)).toBe(true);
  });
});

describe("versionErrorIsRetryable", () => {
  it("returns false for non-error install states including condemned unusable", () => {
    expect(
      versionErrorIsRetryable({ status: "unusable", reason: "condemned" }),
    ).toBe(false);
    expect(versionErrorIsRetryable({ status: "installed" })).toBe(false);
  });

  it("returns true only for allow-listed error reasons", () => {
    expect(
      versionErrorIsRetryable({
        status: "error",
        reason: "network",
        message: "timeout",
        retryAtMs: null,
      }),
    ).toBe(true);
    expect(
      versionErrorIsRetryable({
        status: "error",
        reason: "disk-full",
        message: "no space",
        retryAtMs: null,
      }),
    ).toBe(true);
  });
});

describe("labels and helpers", () => {
  it("labels certification badges for non-eligible states", () => {
    expect(certificationBadgeLabel("yanked")).toBe("Withdrawn");
    expect(certificationBadgeLabel("uncertified")).toBe("No longer published");
    expect(certificationBadgeLabel("below-security-floor")).toBe(
      "Below security minimum",
    );
    expect(certificationBadgeLabel("host-ineligible")).toBe(
      "Not supported on this host",
    );
    expect(certificationBadgeLabel("eligible")).toBeNull();
  });

  it("labels unusable reasons without treating unverified as damage", () => {
    expect(unusableReasonLabel("condemned")).toMatch(/permanently/i);
    expect(unusableReasonLabel("unverified")).toMatch(
      /not necessarily damaged/i,
    );
  });

  it("composes uncertified + unverified without claiming still usable", () => {
    const meta = composeVersionRowMeta({
      installState: { status: "unusable", reason: "unverified" },
      certification: "uncertified",
      sizeLabel: "40 MB",
      recommended: false,
    });
    expect(meta.toLowerCase()).toMatch(/not necessarily damaged/);
    expect(meta.toLowerCase()).toMatch(/no longer published|remains on disk/);
    expect(meta.toLowerCase()).not.toMatch(/still usable/);
  });

  it("finds the recommended version from managed state", () => {
    expect(
      findRecommendedVersion(
        managed([
          version({ version: "1.0.0" }),
          version({ version: "1.2.0", recommended: true }),
          version({ version: "1.3.0" }),
        ]),
      ),
    ).toBe("1.2.0");
    expect(findRecommendedVersion(managed([]))).toBeNull();
  });

  it("compares versions against a baseline with real semver including prereleases", () => {
    expect(isVersionBelowBaseline("1.1.0", "1.2.0")).toBe(true);
    expect(isVersionBelowBaseline("1.2.0", "1.2.0")).toBe(false);
    expect(isVersionBelowBaseline("1.3.0", "1.2.0")).toBe(false);
    // Finding 4: prerelease is strictly below the matching release.
    expect(isVersionBelowBaseline("1.2.3-beta.1", "1.2.3")).toBe(true);
    expect(isVersionBelowBaseline("1.2.3", "1.2.3-beta.1")).toBe(false);
    expect(isVersionBelowBaseline("1.2.3-beta.1", "1.2.3-beta.2")).toBe(true);
  });

  it("matches the SemVer §11 canonical precedence chain (finding 4 harden)", () => {
    // Spec-published chain: catches numeric-vs-alphanumeric identifier
    // ordering and beta.2 < beta.11 (naive string compare gets both wrong).
    const chain = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ] as const;
    for (let i = 0; i < chain.length; i += 1) {
      for (let j = i + 1; j < chain.length; j += 1) {
        expect(isVersionBelowBaseline(chain[i], chain[j])).toBe(true);
        expect(isVersionBelowBaseline(chain[j], chain[i])).toBe(false);
      }
      expect(isVersionBelowBaseline(chain[i], chain[i])).toBe(false);
    }
  });

  it("ignores build metadata for baseline precedence", () => {
    // SemVer §11: +build does not affect ordering.
    expect(isVersionBelowBaseline("1.0.0+abc", "1.0.0+def")).toBe(false);
    expect(isVersionBelowBaseline("1.0.0+build", "1.0.0")).toBe(false);
    expect(isVersionBelowBaseline("1.0.0-rc.1+build", "1.0.0")).toBe(true);
    expect(isVersionBelowBaseline("1.0.0", "1.0.0-rc.1+build")).toBe(false);
  });

  it("fails closed (treats as below) when either side is not SemVer", () => {
    expect(isVersionBelowBaseline("not-a-version", "1.0.0")).toBe(true);
    expect(isVersionBelowBaseline("1.0.0", "not-a-version")).toBe(true);
    // Identity still clears.
    expect(isVersionBelowBaseline("not-a-version", "not-a-version")).toBe(
      false,
    );
  });

  it("sorts versions newest-first with SemVer precedence (not localeCompare)", () => {
    const versions = ["1.0.0-rc.1", "1.0.0-beta.11", "1.0.0-beta.2", "1.0.0"];
    const sorted = [...versions].sort(comparePackVersionsDescending);
    expect(sorted).toEqual([
      "1.0.0",
      "1.0.0-rc.1",
      "1.0.0-beta.11",
      "1.0.0-beta.2",
    ]);
  });

  it("maps every install refusal code to distinct non-transient copy", () => {
    expect(installPackVersionRefusalMessage("condemned")).toMatch(
      /permanently/i,
    );
    expect(installPackVersionRefusalMessage("unfetchable")).toMatch(
      /channel|reconnect|refresh/i,
    );
    expect(
      installPackVersionRefusalMessage("unfetchable").toLowerCase(),
    ).not.toMatch(/right now/);
    expect(installPackVersionRefusalMessage("invalid-version")).toMatch(
      /valid version/i,
    );
    expect(installPackVersionRefusalMessage("pin-below-floor")).toMatch(
      /baseline/i,
    );
    expect(installPackVersionRefusalMessage("below-security-floor")).toMatch(
      /security minimum/i,
    );
    expect(installPackVersionRefusalMessage("host-ineligible")).toMatch(
      /cannot run/i,
    );
    expect(installPackVersionRefusalMessage("yanked")).toMatch(/withdrawn/i);
  });

  it("maps every use/pin refusal code without inviting retry or saying withdrawn", () => {
    expect(packVersionUseRefusalMessage("pin-below-floor")).toMatch(
      /baseline|select/i,
    );
    expect(packVersionUseRefusalMessage("verification-failed")).toMatch(
      /verif/i,
    );
    expect(packVersionUseRefusalMessage("below-security-floor")).toMatch(
      /security minimum/i,
    );
    expect(
      packVersionUseRefusalMessage("below-security-floor").toLowerCase(),
    ).not.toMatch(/right now|withdrawn|try again/);
    expect(packVersionUseRefusalMessage("host-ineligible")).toMatch(
      /cannot run/i,
    );
    expect(
      packVersionUseRefusalMessage("host-ineligible").toLowerCase(),
    ).not.toMatch(/withdrawn|right now/);
  });

  it("denies banner download when the durable update version has no available row", () => {
    const eligibility = updateBannerDownloadEligibility(
      [version({ version: "1.0.0", current: true })],
      "9.9.9",
    );
    expect(eligibility.allowed).toBe(false);
    if (!eligibility.allowed) {
      expect(eligibility.reason.toLowerCase()).toMatch(
        /fetchable|reconnect|download/,
      );
    }
  });

  it("formats pack sizes and preserves null for yank tombstones", () => {
    expect(formatPackSizeBytes(null)).toBeNull();
    expect(formatPackSizeBytes(512)).toBe("512 B");
    expect(formatPackSizeBytes(40_000_000)).toMatch(/MB/);
  });
});
