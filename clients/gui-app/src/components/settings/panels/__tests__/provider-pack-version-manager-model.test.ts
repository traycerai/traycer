import { describe, expect, it } from "vitest";
import type {
  ProviderManagedVersions,
  ProviderPackVersion,
} from "@traycer/protocol/host/provider-schemas";
import {
  certificationBadgeLabel,
  certificationMetaLine,
  comparePackVersionsDescending,
  findRecommendedVersion,
  formatSharedWithProvidersLine,
  installErrorReasonLabel,
  installPackVersionRefusalMessage,
  removeResultUserMessage,
  unusableReasonLabel,
  updateBannerDownloadEligibility,
  packVersionUseRefusalMessage,
  versionDeleteEligibility,
  versionDownloadEligibility,
  versionErrorIsRetryable,
  versionInstallFetchLabel,
  versionRowChip,
  versionShowsDeleteAction,
  versionShowsInstallFetchAction,
  versionTroubleLine,
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

type ErrorInstallState = Extract<
  ProviderPackVersion["installState"],
  { status: "error" }
>;

// Typed on the protocol reason union, not `string`. With the assertion a
// misspelled reason still compiled, and the test then exercised the
// default-deny arm while claiming to cover the named one.
function errorState(reason: ErrorInstallState["reason"]): ErrorInstallState {
  return {
    status: "error",
    reason,
    message: reason,
    retryAtMs: null,
  };
}

describe("versionUseEligibility", () => {
  it("allows Use for an installed version below the recommended baseline (D1 as revised 2026-08-12)", () => {
    // The below-baseline disable and the offline fail-closed arm are gone:
    // the host refuses `below-security-floor` / `host-ineligible` server-side,
    // and those arrive as certification on the row, not as a baseline math
    // problem for the client.
    const row = version({
      version: "1.0.0",
      installState: { status: "installed" },
    });
    expect(versionUseEligibility(row)).toEqual({ allowed: true });
  });

  it("allows Use for an installed version above the recommended baseline and not current", () => {
    const row = version({
      version: "1.3.0",
      installState: { status: "installed" },
    });
    expect(versionUseEligibility(row)).toEqual({ allowed: true });
  });

  it("disables Use for the current installed version", () => {
    const row = version({
      version: "1.2.0",
      current: true,
      installState: { status: "installed" },
    });
    const result = versionUseEligibility(row);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason.toLowerCase()).toMatch(/already current|current/);
    }
  });

  it("allows Use for an installed yanked copy when not current (D8)", () => {
    // Yanked certification does not block Use in the model once installed.
    const row = version({
      version: "1.3.0",
      certification: "yanked",
      installState: { status: "installed" },
    });
    expect(versionUseEligibility(row)).toEqual({ allowed: true });
  });

  it("disables Use on the signed positive refusals, regardless of position", () => {
    for (const certification of [
      "below-security-floor",
      "host-ineligible",
    ] as const) {
      const result = versionUseEligibility(
        version({
          version: "1.3.0",
          certification,
          installState: { status: "installed" },
        }),
      );
      expect(result.allowed).toBe(false);
      // Pin the BRANCH, not just the flag. `versionUseEligibility` refuses for
      // three different reasons; asserting `allowed === false` alone stays
      // green if the certification check regresses and the not-installed arm
      // answers instead.
      if (!result.allowed) {
        expect(result.reason).toBe(certificationMetaLine(certification));
      }
    }
  });

  it("disables Use for a row that is not installed", () => {
    const result = versionUseEligibility(
      version({ version: "1.0.0", installState: { status: "absent" } }),
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason.toLowerCase()).toContain("install");
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

  // The host reserves a quarantined directory as evidence of a failed
  // verification and answers `quarantine-reserved`, so an enabled Delete here
  // is an action offered solely to be refused.
  it("does not allow Delete for a quarantined version", () => {
    const result = versionDeleteEligibility(
      version({
        version: "1.1.0",
        current: false,
        installState: { status: "unusable", reason: "quarantined" },
      }),
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      // Same sentence the refusal itself would produce, so the two cannot
      // drift apart.
      expect(result.reason).toBe(
        removeResultUserMessage({
          ok: false,
          code: "quarantine-reserved",
          detail: null,
        }),
      );
    }
  });

  // The other unusable reasons are NOT reserved - the bytes are just bad, and
  // deleting them is the repair.
  it("still allows Delete for the other unusable reasons", () => {
    for (const reason of ["corrupt", "unverified", "condemned"] as const) {
      expect(
        versionDeleteEligibility(
          version({
            version: "1.1.0",
            current: false,
            installState: { status: "unusable", reason },
          }),
        ),
      ).toEqual({ allowed: true });
    }
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

describe("copy and label rules with no coverage before this", () => {
  // `deferred-locked` is the one remove refusal that is NOT a failure: the
  // host queues the delete for boot GC. The panel renders it as an `info`
  // notice on that reasoning, so copy that reads as an error would contradict
  // the surface it appears on.
  it("states deferred-locked removal as queued, not as a failure", () => {
    const message = removeResultUserMessage({
      ok: false,
      code: "deferred-locked",
      detail: null,
    });
    expect(message).toMatch(/removes when no longer in use/iu);
    expect(message.toLowerCase()).not.toContain("fail");
  });

  it("prefers the host detail when one is supplied", () => {
    expect(
      removeResultUserMessage({
        ok: false,
        code: "is-current",
        detail: "Pinned as current for this pack",
      }),
    ).toBe("Pinned as current for this pack");
  });

  // Retry is a promise that trying again can work. It may only appear for the
  // reasons on the retryable allow-list; every other error state still offers
  // Download, and `versionDownloadEligibility` is what disables it.
  it("labels the fetch action Retry only for a retryable error", () => {
    expect(
      versionInstallFetchLabel(
        version({ version: "1.0.0", installState: errorState("network") }),
      ),
    ).toBe("Retry");
    expect(
      versionInstallFetchLabel(
        version({
          version: "1.0.0",
          installState: errorState("trust-unavailable"),
        }),
      ),
    ).toBe("Download");
  });

  it("labels absent and unusable rows Download", () => {
    expect(
      versionInstallFetchLabel(
        version({ version: "1.0.0", installState: { status: "absent" } }),
      ),
    ).toBe("Download");
    expect(
      versionInstallFetchLabel(
        version({
          version: "1.0.0",
          installState: { status: "unusable", reason: "corrupt" },
        }),
      ),
    ).toBe("Download");
  });

  it("joins one, two and three shared providers the way English does", () => {
    expect(formatSharedWithProvidersLine([])).toBeNull();
    expect(formatSharedWithProvidersLine(["opencode"])).toBe(
      "Shared by OpenCode",
    );
    expect(formatSharedWithProvidersLine(["opencode", "traycer"])).toBe(
      "Shared by OpenCode and Traycer",
    );
    expect(
      formatSharedWithProvidersLine(["opencode", "traycer", "openrouter"]),
    ).toBe("Shared by OpenCode, Traycer, and OpenRouter");
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

  it("gives every install-error reason its own sentence", () => {
    // Totality matters more than the wording: a reason with no case would be a
    // compile error, but two reasons collapsing onto one sentence would not,
    // and that silently loses the retry/no-retry distinction.
    const reasons = [
      "disk-full",
      "network",
      "verification",
      "unknown",
      "unrepairable",
      "live-owner-stalled",
      "trust-unavailable",
      "local-storage-mismatch",
    ] as const;
    const sentences = reasons.map((reason) => installErrorReasonLabel(reason));
    expect(new Set(sentences).size).toBe(reasons.length);
    for (const sentence of sentences)
      expect(sentence.length).toBeGreaterThan(0);
  });

  it("speaks a broken row's trouble from the typed reason, never the wire message", () => {
    // `message` is documented as the UNDERLYING operator-facing detail and can
    // carry raw filesystem or network text. This assertion used to live on
    // `composeVersionRowMeta`, which the hover card's removal deleted; the
    // invariant outlived the function, so it moves here.
    const raw = "ENOSPC: no space left on device, write '/var/tmp/pack.part'";
    const line = versionTroubleLine(
      version({
        version: "1.0.0",
        installState: {
          status: "error",
          reason: "disk-full",
          message: raw,
          retryAtMs: null,
        },
      }),
    );
    expect(line).not.toBeNull();
    expect(line).not.toContain(raw);
    expect(line).not.toContain("ENOSPC");
    expect(line).toBe(installErrorReasonLabel("disk-full"));
  });

  it("gives a healthy row no trouble line at all", () => {
    // The redesign's whole premise: a row that is fine is a number, a chip and
    // its controls. If this ever returns a string for `installed` or `absent`,
    // every healthy row grows a second line and the list is a wall again.
    for (const state of [
      { status: "installed" },
      { status: "absent" },
      { status: "downloading", percent: 42 },
    ] as const) {
      expect(
        versionTroubleLine(version({ version: "1.0.0", installState: state })),
      ).toBeNull();
    }
  });

  it("speaks a blocking certification on the CURRENT row, whose chip slot `Current` owns", () => {
    // `versionRowChip` hands `Current` the chip unconditionally, so a current
    // version that is later withdrawn has nowhere else to say so. Non-current
    // blocked rows wear the certification AS their chip and must not get a
    // second copy here.
    for (const certification of [
      "yanked",
      "below-security-floor",
      "host-ineligible",
    ] as const) {
      const current = version({
        version: "1.0.0",
        current: true,
        certification,
        installState: { status: "installed" },
      });
      expect(versionRowChip(current)?.label).toBe("Current");
      expect(versionTroubleLine(current)).toBe(
        certificationMetaLine(certification),
      );

      const sibling = version({
        version: "0.9.0",
        current: false,
        certification,
        installState: { status: "installed" },
      });
      expect(versionRowChip(sibling)?.tone).toBe("blocked");
      expect(versionTroubleLine(sibling)).toBeNull();
    }
    // `uncertified` is NOT blocking (D8): a current copy the channel stopped
    // listing stays usable and must stay quiet.
    expect(
      versionTroubleLine(
        version({
          version: "1.0.0",
          current: true,
          certification: "uncertified",
          installState: { status: "installed" },
        }),
      ),
    ).toBeNull();
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

  it("orders the SemVer §11 canonical precedence chain (finding 4 harden)", () => {
    // Spec-published chain: catches numeric-vs-alphanumeric identifier
    // ordering and beta.2 < beta.11 (naive string compare gets both wrong).
    // Anchored on the list's own comparator since the baseline predicate
    // left with the 2026-08-12 D1 revision.
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
        expect(
          comparePackVersionsDescending(chain[i], chain[j]),
        ).toBeGreaterThan(0);
        expect(comparePackVersionsDescending(chain[j], chain[i])).toBeLessThan(
          0,
        );
      }
      expect(comparePackVersionsDescending(chain[i], chain[i])).toBe(0);
    }
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
    expect(installPackVersionRefusalMessage("below-security-floor")).toMatch(
      /security minimum/i,
    );
    expect(installPackVersionRefusalMessage("host-ineligible")).toMatch(
      /cannot run/i,
    );
    expect(installPackVersionRefusalMessage("yanked")).toMatch(/withdrawn/i);
  });

  it("maps every use/pin refusal code without inviting retry or saying withdrawn", () => {
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

  it("gives an unpublished version a chip that outranks Recommended", () => {
    // The signal this chip carries is "deleting this is permanent", because an
    // unpublished version cannot be fetched again. A version can be BOTH
    // unpublished and recommended, and of the two only one of them changes
    // what pressing delete costs - so the warning has to win. This ordering
    // is the whole reason the chip exists; before it, the state lived only in
    // a hover card, and deleting the card would have taken it with it.
    const chip = versionRowChip(
      version({
        version: "1.0.0",
        recommended: true,
        certification: "uncertified",
        installState: { status: "installed" },
      }),
    );
    expect(chip).toEqual({ label: "Unpublished", tone: "unpublished" });
  });

  it("still lets Current outrank an unpublished chip", () => {
    // Not an oversight that the warning loses here: delete is refused for the
    // current version outright, so there is no reversibility question to warn
    // about on this row.
    const chip = versionRowChip(
      version({
        version: "1.0.0",
        current: true,
        certification: "uncertified",
        installState: { status: "installed" },
      }),
    );
    expect(chip).toEqual({ label: "Current", tone: "current" });
  });

  it("shows a Delete control for anything with bytes on disk, and only that", () => {
    // `versionShowsDeleteAction` is what lets a BLOCKED delete still render as
    // a disabled button carrying its reason. The quarantine case is the one
    // that regressed before: the panel hardcoded a `current`-only disabled arm,
    // so a quarantined row rendered no control and never showed the sentence
    // `versionDeleteEligibility` computes for it.
    const onDisk = [
      version({ version: "1.0.0", installState: { status: "installed" } }),
      version({
        version: "1.1.0",
        installState: { status: "unusable", reason: "quarantined" },
      }),
      version({
        version: "1.2.0",
        current: true,
        installState: { status: "installed" },
      }),
    ];
    for (const row of onDisk) expect(versionShowsDeleteAction(row)).toBe(true);

    const notOnDisk = [
      version({ version: "2.0.0", installState: { status: "absent" } }),
      version({
        version: "2.1.0",
        installState: { status: "downloading", percent: 42 },
      }),
      version({
        version: "2.2.0",
        installState: {
          status: "error",
          reason: "network",
          message: "timeout",
          retryAtMs: null,
        },
      }),
    ];
    for (const row of notOnDisk)
      expect(versionShowsDeleteAction(row)).toBe(false);
  });
});
