import { describe, expect, it } from "vitest";
import {
  downgradeRequestAcrossMajors,
  downgradeResponseAcrossMajors,
  upgradeResponseToVersion,
} from "@traycer/protocol/framework/versioned-rpc";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  providerCliStateSchema,
  providerManagedInstallStateSchema,
  providerManagedVersionsSchema,
  providerManagedVersionsUnavailableSchema,
  providerPackVersionCertificationSchema,
  providerPackVersionInstallStateSchema,
  providerPackVersionSchema,
  providerPackVersionUnusableReasonSchema,
  providersEnsurePackRequestSchema,
  providersEnsurePackResponseSchema,
  providersInstallPackVersionRequestSchema,
  providersInstallPackVersionResponseSchema,
  providersListRequestSchema,
  providersListResponseSchema,
  providersListResponseSchemaV60,
  providersRemovePackVersionRequestSchema,
  providersRemovePackVersionResponseSchema,
  providersSetPackPolicyRequestSchema,
  providersSetPackPolicyResponseSchema,
  providersUsePackVersionRequestSchema,
  providersUsePackVersionResponseSchema,
} from "@traycer/protocol/host/provider-schemas";

function providerState(providerId: string) {
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" as const },
    candidates: [],
    auth: {
      status: "unknown" as const,
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    profiles: [],
  };
}

const MANAGED_VERSIONS = {
  autoDownload: true,
  pinnedVersion: null,
  updateAvailable: null,
  sharedWithProviders: ["codex"],
  totalSizeBytes: null,
  available: [
    {
      version: "1.2.3",
      sizeBytes: null,
      certification: "uncertified" as const,
      recommended: true,
      current: true,
      installState: { status: "installed" as const },
    },
  ],
};

function versionManagerProviderState(providerId: string) {
  return {
    ...providerState(providerId),
    packId: "pack-shared",
    managedVersions: MANAGED_VERSIONS,
    nextRunBinary: {
      kind: "managed" as const,
      path: "/managed/pack-shared/1.2.3/bin",
      version: "1.2.3",
    },
    managedInstallState: {
      status: "installed" as const,
      version: "1.2.3",
    },
  };
}

describe("providers.list@7.0 carries the version manager and bridges older lines", () => {
  it("keeps every version-manager field on the head line and strips them for a v6.0 peer", () => {
    // This is the primary bridge guard. v7.0 is the head line and the ONLY one
    // that models the version manager: v8.0 opened for these fields while v7.0
    // was still unreleased, and the release collapsed the two back into one.
    // The strip therefore happens on the v7 -> v6 hop, and v6.0 models no
    // managed-install slot at all - so what has to hold is that the whole key
    // set is absent, not merely that its values were blanked.
    const response = providersListResponseSchema.parse({
      providers: [versionManagerProviderState("claude-code")],
      native: null,
    });
    expect(response.providers[0]).toMatchObject({
      packId: "pack-shared",
      managedVersions: MANAGED_VERSIONS,
      nextRunBinary: {
        kind: "managed",
        path: "/managed/pack-shared/1.2.3/bin",
        version: "1.2.3",
      },
      managedInstallState: { status: "installed", version: "1.2.3" },
    });

    const downgraded = downgradeResponseAcrossMajors(
      hostRpcRegistry["providers.list"],
      7,
      6,
      response,
    );
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    expect(downgraded.value.providers).toHaveLength(1);
    for (const key of [
      "packId",
      "managedVersions",
      "managedVersionsUnavailable",
      "nextRunBinary",
      "managedInstallState",
    ]) {
      expect(downgraded.value.providers[0], key).not.toHaveProperty(key);
    }
    expect(
      providersListResponseSchemaV60.safeParse(downgraded.value).success,
    ).toBe(true);
  });

  it("downgrades to v6..v1, drops huggingface below v7, and strips native below v7", () => {
    // `huggingface` and `native` both ride v7.0; every frozen line below it has
    // an older provider-id enum and no native carrier on the response.
    const response = providersListResponseSchema.parse({
      providers: [
        versionManagerProviderState("claude-code"),
        versionManagerProviderState("huggingface"),
      ],
      native: { ok: true, kind: "skills", skills: [] },
    });
    expect(response.providers.map((provider) => provider.providerId)).toEqual([
      "claude-code",
      "huggingface",
    ]);

    for (const target of [6, 5, 4, 3, 2, 1] as const) {
      const downgraded = downgradeResponseAcrossMajors(
        hostRpcRegistry["providers.list"],
        7,
        target,
        response,
      );
      expect(downgraded.ok, `v${target}`).toBe(true);
      if (!downgraded.ok) continue;
      expect(
        downgraded.value.providers.map((provider) => provider.providerId),
        `v${target} provider ids`,
      ).toEqual(["claude-code"]);
      expect(downgraded.value).not.toHaveProperty("native");
    }
  });

  it("reparses the request for every peer below v7 rather than passing it through", () => {
    // v7.0 is the only line whose REQUEST models the `native` carrier, so a
    // pass-through to any older peer would hand it a field its schema does not
    // model. Asserting `not.toBe(request)` is what distinguishes a real reparse
    // from an identity that happens to look equal.
    const request = providersListRequestSchema.parse({
      forceAuthRefresh: true,
      native: {
        kind: "mcp",
        providerId: "claude-code",
        scope: "global",
        workspaceRoot: null,
      },
    });

    for (const target of [6, 5, 4, 3, 2, 1] as const) {
      const downgraded = downgradeRequestAcrossMajors(
        hostRpcRegistry["providers.list"],
        7,
        target,
        request,
      );
      expect(downgraded.ok, `v${target}`).toBe(true);
      if (!downgraded.ok) continue;
      expect(downgraded.value, `v${target} reparses`).not.toBe(request);
      expect(downgraded.value).toEqual({ forceAuthRefresh: true });
      expect(downgraded.value).not.toHaveProperty("native");
    }
  });
});

describe("providers.list@6.0 -> @7.0 upgrades", () => {
  it("fills every version-manager field for a v6.0 host and lands on the live shape", () => {
    // The fill used to be split across two hops - v6 -> v7 for the registry and
    // native fields, v7 -> v8 for the version manager. Collapsing v8.0 into
    // v7.0 merged them, and this is the guard that the second half survived the
    // merge: deleting a version is never just deleting its contract, whatever
    // its bridge did has to land on the surviving hop.
    const oldResponse = providersListResponseSchemaV60.parse({
      providers: [providerState("codex")],
    });
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["providers.list"],
      { major: 6, minor: 0 },
      { major: 7, minor: 0 },
      oldResponse,
    );

    const upgradedState = upgraded.providers[0];
    expect(upgradedState.packId).toBeNull();
    expect(upgradedState.managedVersions).toBeNull();
    expect(upgradedState.nextRunBinary).toBeNull();
    // A v6.0 row can never carry a managed-install arm: v6.0 does not model the
    // slot, and the hop's own pre-registry fill nulls it unconditionally. So
    // the honest projection is `null` outright rather than an arm-by-arm lift.
    expect(upgradedState.managedInstallState).toBeNull();
    expect(upgradedState.nativeCapabilities.modelProviders).toBeNull();
    expect(upgraded.native).toBeNull();
    // `upgradeResponseToVersion` chains these callbacks BY CAST with no
    // re-parse, so a missing required key would not surface at the hop - it
    // would surface as a failed decode on whatever consumer parsed the result
    // later. This parse is what stands in for that consumer.
    expect(() => providersListResponseSchema.parse(upgraded)).not.toThrow();
  });

  it("keeps a populated managed-install version on the head line and off every older peer", () => {
    // This proves only that a populated `version` survives the head schema and
    // reaches no older peer. It does NOT prove a host producer ever populates
    // the optional field: absence is valid at the protocol layer. The host's
    // wire-assembly tests must assert that an in-flight download's assembled
    // row carries a non-null version; protocol tests cannot observe host
    // construction and must not retire that suspicion.
    for (const managedInstallState of [
      { status: "downloading" as const, percent: 50, version: "1.2.3" },
      { status: "installed" as const, version: "1.2.3" },
    ]) {
      const response = providersListResponseSchema.parse({
        providers: [
          {
            ...versionManagerProviderState("codex"),
            managedInstallState,
          },
        ],
        native: null,
      });
      expect(response.providers[0].managedInstallState).toHaveProperty(
        "version",
        "1.2.3",
      );

      const downgraded = downgradeResponseAcrossMajors(
        hostRpcRegistry["providers.list"],
        7,
        6,
        response,
      );
      expect(downgraded.ok).toBe(true);
      if (!downgraded.ok) continue;
      // Asserting the WHOLE key is absent, not just `version`: v6.0 models no
      // managed-install slot, so a `not.toHaveProperty("version")` on an
      // already-absent object would pass without proving anything.
      expect(downgraded.value.providers[0]).not.toHaveProperty(
        "managedInstallState",
      );
    }
  });
});

describe("per-pack RPC contracts", () => {
  const contracts = [
    {
      method: "providers.installPackVersion",
      requestSchema: providersInstallPackVersionRequestSchema,
      responseSchema: providersInstallPackVersionResponseSchema,
    },
    {
      method: "providers.removePackVersion",
      requestSchema: providersRemovePackVersionRequestSchema,
      responseSchema: providersRemovePackVersionResponseSchema,
    },
    {
      method: "providers.usePackVersion",
      requestSchema: providersUsePackVersionRequestSchema,
      responseSchema: providersUsePackVersionResponseSchema,
    },
    {
      method: "providers.setPackPolicy",
      requestSchema: providersSetPackPolicyRequestSchema,
      responseSchema: providersSetPackPolicyResponseSchema,
    },
  ] as const;

  it("registers each new @1.0 name with unsupported degradation", () => {
    for (const expected of contracts) {
      const entry = hostRpcRegistry[expected.method];
      expect(entry).toBeDefined();
      expect(entry.degrade).toEqual({ kind: "unsupported" });
      expect(entry[1].latestMinor).toBe(0);
      expect(entry[1].versions[0].contract.method).toBe(expected.method);
      expect(entry[1].versions[0].contract.schemaVersion).toEqual({
        major: 1,
        minor: 0,
      });
      expect(entry[1].versions[0].contract.requestSchema).toBe(
        expected.requestSchema,
      );
      expect(entry[1].versions[0].contract.responseSchema).toBe(
        expected.responseSchema,
      );
    }
  });

  it("keeps providers.ensurePack at @1.0 with its original schemas", () => {
    const entry = hostRpcRegistry["providers.ensurePack"];
    expect(entry[1].versions[0].contract.requestSchema).toBe(
      providersEnsurePackRequestSchema,
    );
    expect(entry[1].versions[0].contract.responseSchema).toBe(
      providersEnsurePackResponseSchema,
    );
    expect(entry[1].versions[0].contract.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
    expect(providersEnsurePackRequestSchema.safeParse({ providerId: "codex" }).success).toBe(
      true,
    );
    expect(providersEnsurePackResponseSchema.parse({ managedInstallState: null })).toEqual({
      managedInstallState: null,
    });
  });

  it("accepts valid requests/responses, rejects malformed payloads, and round-trips every typed error", () => {
    expect(
      providersInstallPackVersionRequestSchema.safeParse({
        packId: "pack-shared",
        version: "1.2.3",
      }).success,
    ).toBe(true);
    expect(
      providersInstallPackVersionRequestSchema.safeParse({
        packId: "",
        version: "1.2.3",
      }).success,
    ).toBe(false);
    expect(
      providersInstallPackVersionResponseSchema.safeParse({
        result: { ok: true, installState: { status: "installed" } },
      }).success,
    ).toBe(true);
    // All six, written out literally. The enum is one member per producer
    // outcome of `resolveUserPickedProviderPackTarget` (four arms fanning out
    // to six refusals; `pin-below-floor` left with the 2026-08-12 D1
    // revision), so a member silently disappearing here would leave the host
    // with a real refusal it cannot express and force a lossy "closest fit"
    // at the resolver - the collapse the enum's own comment exists to
    // prevent. Listed rather than derived from `.options` for the same
    // reason the v7.0 key-set pins are literal: a derived list stays green
    // through exactly the drift it is supposed to catch.
    for (const code of [
      "condemned",
      "unfetchable",
      "invalid-version",
      "below-security-floor",
      "host-ineligible",
      "yanked",
    ] as const) {
      const parsed = providersInstallPackVersionResponseSchema.parse({
        result: { ok: false, code, detail: "not available" },
      });
      expect(parsed.result).toEqual({ ok: false, code, detail: "not available" });
    }
    // The enum is closed: a plausible-looking code the producer never emits
    // must not decode, or a typo'd resolver would ship a refusal no renderer
    // has copy for.
    expect(
      providersInstallPackVersionResponseSchema.safeParse({
        result: { ok: false, code: "ineligible", detail: null },
      }).success,
    ).toBe(false);

    expect(
      providersRemovePackVersionRequestSchema.safeParse({
        packId: "pack-shared",
        version: "1.2.3",
      }).success,
    ).toBe(true);
    expect(
      providersRemovePackVersionResponseSchema.safeParse({
        result: { ok: true },
      }).success,
    ).toBe(true);
    for (const code of [
      "is-current",
      "holder-reserved",
      "quarantine-reserved",
      "deferred-locked",
    ] as const) {
      const parsed = providersRemovePackVersionResponseSchema.parse({
        result: { ok: false, code, detail: null },
      });
      expect(parsed.result).toEqual({ ok: false, code, detail: null });
    }
    expect(
      providersRemovePackVersionResponseSchema.safeParse({
        result: { ok: false, code: "is-current" },
      }).success,
    ).toBe(false);

    expect(
      providersUsePackVersionRequestSchema.safeParse({
        packId: "pack-shared",
        version: null,
      }).success,
    ).toBe(true);
    expect(
      providersUsePackVersionResponseSchema.safeParse({
        result: { ok: true, pinnedVersion: null },
      }).success,
    ).toBe(true);
    for (const code of [
      "verification-failed",
      "below-security-floor",
      "host-ineligible",
    ] as const) {
      const parsed = providersUsePackVersionResponseSchema.parse({
        result: { ok: false, code, detail: "refused" },
      });
      expect(parsed.result).toEqual({ ok: false, code, detail: "refused" });
    }
    expect(
      providersUsePackVersionRequestSchema.safeParse({
        packId: "pack-shared",
        version: 123,
      }).success,
    ).toBe(false);

    expect(
      providersSetPackPolicyRequestSchema.safeParse({
        packId: "pack-shared",
        autoDownload: false,
      }).success,
    ).toBe(true);
    expect(
      providersSetPackPolicyResponseSchema.parse({ autoDownload: false }),
    ).toEqual({ autoDownload: false });
    expect(
      providersSetPackPolicyResponseSchema.safeParse({
        autoDownload: "no",
      }).success,
    ).toBe(false);
    expect(
      providersSetPackPolicyRequestSchema.safeParse({
        packId: "pack-shared",
        autoDownload: "yes",
      }).success,
    ).toBe(false);
  });
});

describe("provider-pack schema distinctions", () => {
  it("keeps uncertified distinct from yanked and eligible", () => {
    // The protocol keeps `uncertified` as a distinct value; collapsing it into
    // `yanked` or `eligible` would erase the distinction for consumers.
    for (const certification of ["eligible", "yanked", "uncertified"] as const) {
      const parsed = providerPackVersionSchema.parse({
        version: "1.2.3",
        sizeBytes: null,
        certification,
        recommended: false,
        current: false,
        installState: { status: "installed" },
      });
      expect(parsed.certification).toBe(certification);
    }
    expect(providerPackVersionCertificationSchema.options).toContain("uncertified");
  });

  it("keeps unverified distinct from corrupt and both round-trip as unusable", () => {
    for (const reason of ["unverified", "corrupt"] as const) {
      const parsed = providerPackVersionInstallStateSchema.parse({
        status: "unusable",
        reason,
      });
      expect(parsed).toEqual({ status: "unusable", reason });
    }
    expect(providerPackVersionUnusableReasonSchema.options).toContain("unverified");
    expect(providerPackVersionUnusableReasonSchema.options).toContain("corrupt");
  });

  it("treats null download percent as a transient downloading state, not error", () => {
    const parsed = providerPackVersionInstallStateSchema.parse({
      status: "downloading",
      percent: null,
    });
    expect(parsed).toEqual({ status: "downloading", percent: null });
    expect(parsed.status).not.toBe("error");
    expect(providerManagedInstallStateSchema.parse({
      status: "downloading",
      percent: null,
      version: null,
    })).toEqual({ status: "downloading", percent: null, version: null });
  });

  it("accepts a null size tombstone and only the multi-version union has unusable", () => {
    expect(
      providerPackVersionSchema.parse({
        version: "1.2.3",
        sizeBytes: null,
        certification: "yanked",
        recommended: false,
        current: false,
        installState: { status: "absent" },
      }).sizeBytes,
    ).toBeNull();
    expect(
      providerPackVersionInstallStateSchema.safeParse({
        status: "unusable",
        reason: "corrupt",
      }).success,
    ).toBe(true);
    expect(
      providerManagedInstallStateSchema.safeParse({
        status: "unusable",
        reason: "corrupt",
      }).success,
    ).toBe(false);
  });

  it("degrades an unknown shared provider id to [] without dropping managedVersions or the row", () => {
    // `.catch([])` belongs on the array: without it, the nested failure would
    // trigger managedVersions' `.catch(null)` and erase the whole version panel.
    const managedVersions = providerManagedVersionsSchema.parse({
      ...MANAGED_VERSIONS,
      sharedWithProviders: ["provider-added-after-this-client"],
    });
    expect(managedVersions.sharedWithProviders).toEqual([]);
    const row = providerCliStateSchema.parse({
      ...versionManagerProviderState("claude-code"),
      managedVersions: {
        ...MANAGED_VERSIONS,
        sharedWithProviders: ["provider-added-after-this-client"],
      },
    });
    expect(row.managedVersions).not.toBeNull();
    expect(row.managedVersions?.sharedWithProviders).toEqual([]);
    expect(row.packId).toBe("pack-shared");
  });
});

describe("managedVersionsUnavailable: why the panel is absent", () => {
  it("accepts every reason the host can produce", () => {
    for (const reason of [
      "registry-unconfigured",
      "registry-unreachable",
      "registry-not-yet-checked",
      "install-manager-unavailable",
    ] as const) {
      expect(
        providerManagedVersionsUnavailableSchema.parse({ reason }),
      ).toEqual({ reason });
    }
  });

  it("rejects a reason outside the enum rather than inventing one", () => {
    expect(
      providerManagedVersionsUnavailableSchema.safeParse({
        reason: "something-new",
      }).success,
    ).toBe(false);
  });

  // The field-level `.catch(null)` must degrade only THIS field. A newer host
  // sending a reason this client does not know must not take the row - or the
  // version panel next to it - down with it.
  it("degrades an unknown reason to null without disturbing managedVersions", () => {
    const parsed = providerCliStateSchema.parse({
      ...versionManagerProviderState("claude-code"),
      managedVersions: MANAGED_VERSIONS,
      managedVersionsUnavailable: { reason: "reason-from-a-newer-host" },
    });
    expect(parsed.managedVersionsUnavailable).toBeNull();
    expect(parsed.managedVersions).not.toBeNull();
  });
});
