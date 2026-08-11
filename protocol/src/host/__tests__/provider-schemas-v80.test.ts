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
  providersListResponseSchemaV70,
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

function v8ProviderState(providerId: string) {
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

describe("providers.list@8.0 freezes v7 and bridges all older lines", () => {
  it("keeps all four v8 fields live but strips all four through the real v8->v7 bridge", () => {
    // This is the primary bridge guard: if the v8->v7 path stops reparsing
    // through the frozen v7 schema, these fields survive the bridge and this
    // turns red. The separate v7 contract-identity test covers the registry
    // pointer itself.
    const response = providersListResponseSchema.parse({
      providers: [v8ProviderState("claude-code")],
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

    const frozen = providersListResponseSchemaV70.parse({
      providers: [response.providers[0]],
      native: null,
    });
    expect(frozen.providers[0].managedInstallState).toEqual({
      status: "installed",
    });
    expect(frozen.providers[0]).not.toHaveProperty("packId");
    expect(frozen.providers[0]).not.toHaveProperty("managedVersions");
    expect(frozen.providers[0]).not.toHaveProperty(
      "managedVersionsUnavailable",
    );
    expect(frozen.providers[0]).not.toHaveProperty("nextRunBinary");

    const downgraded = downgradeResponseAcrossMajors(
      hostRpcRegistry["providers.list"],
      8,
      7,
      response,
    );
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    expect(downgraded.value.providers).toHaveLength(1);
    expect(downgraded.value.providers[0]).not.toHaveProperty("packId");
    expect(downgraded.value.providers[0]).not.toHaveProperty("managedVersions");
    expect(downgraded.value.providers[0]).not.toHaveProperty(
      "managedVersionsUnavailable",
    );
    expect(downgraded.value.providers[0]).not.toHaveProperty("nextRunBinary");
    expect(downgraded.value.providers[0].managedInstallState).toEqual({
      status: "installed",
    });
    expect(providersListResponseSchemaV70.safeParse(downgraded.value).success).toBe(
      true,
    );
  });

  it("downgrades to v6..v1, drops huggingface below v7, and strips native below v7", () => {
    // v8 adds no provider ids, so v7 keeps huggingface and native. Older
    // frozen lines have both an older provider-id enum and no native response.
    const response = providersListResponseSchema.parse({
      providers: [
        v8ProviderState("claude-code"),
        v8ProviderState("huggingface"),
      ],
      native: { ok: true, kind: "skills", skills: [] },
    });
    const v7 = downgradeResponseAcrossMajors(
      hostRpcRegistry["providers.list"],
      8,
      7,
      response,
    );
    expect(v7.ok).toBe(true);
    if (!v7.ok) return;
    expect(v7.value.providers.map((provider) => provider.providerId)).toEqual([
      "claude-code",
      "huggingface",
    ]);
    expect(v7.value.native).toEqual(response.native);

    for (const target of [6, 5, 4, 3, 2, 1] as const) {
      const downgraded = downgradeResponseAcrossMajors(
        hostRpcRegistry["providers.list"],
        8,
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
      if (target === 6) {
        expect(providersListResponseSchemaV60.safeParse(downgraded.value).success).toBe(
          true,
        );
      }
    }
  });

  it("passes the v8->v7 request through unchanged, while reparsing v8->v6 and below", () => {
    const request = providersListRequestSchema.parse({
      forceAuthRefresh: true,
      native: {
        kind: "mcp",
        providerId: "claude-code",
        scope: "global",
        workspaceRoot: null,
      },
    });
    const v7 = downgradeRequestAcrossMajors(
      hostRpcRegistry["providers.list"],
      8,
      7,
      request,
    );
    expect(v7.ok).toBe(true);
    if (!v7.ok) return;
    expect(v7.value).toBe(request);
    expect(v7.value.native).toEqual(request.native);

    for (const target of [6, 5, 4, 3, 2, 1] as const) {
      const downgraded = downgradeRequestAcrossMajors(
        hostRpcRegistry["providers.list"],
        8,
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

describe("providers.list@7.0 -> @8.0 upgrades", () => {
  it("fills null v8 fields and lifts each managed-install arm without adding version to absent", () => {
    // The absent arm deliberately has no version key. The other three get an
    // explicit null because v7 had no per-version concept to populate.
    const cases = [
      { status: "absent" as const },
      { status: "downloading" as const, percent: null },
      { status: "installed" as const },
      {
        status: "error" as const,
        reason: "network" as const,
        message: "registry unreachable",
        retryAtMs: null,
      },
    ];
    for (const managedInstallState of cases) {
      const oldResponse = providersListResponseSchemaV70.parse({
        providers: [
          {
            ...providerState("codex"),
            managedInstallState,
          },
        ],
        native: null,
      });
      const upgraded = upgradeResponseToVersion(
        hostRpcRegistry["providers.list"],
        { major: 7, minor: 0 },
        { major: 8, minor: 0 },
        oldResponse,
      );
      const upgradedState = upgraded.providers[0];
      expect(upgradedState.packId).toBeNull();
      expect(upgradedState.managedVersions).toBeNull();
      expect(upgradedState.nextRunBinary).toBeNull();
      if (managedInstallState.status === "absent") {
        expect(upgradedState.managedInstallState).toEqual({ status: "absent" });
        expect(upgradedState.managedInstallState).not.toHaveProperty("version");
      } else {
        expect(upgradedState.managedInstallState).toHaveProperty("version", null);
      }
      expect(() => providersListResponseSchema.parse(upgraded)).not.toThrow();
    }
  });

  it("preserves populated managed-install versions on v8 and strips them through the real v8->v7 bridge", () => {
    // This proves only that a populated `version` survives the v8 schema and
    // that the frozen v7 line strips it. It does NOT prove a host producer ever
    // populates this optional field: absence is valid at the protocol layer.
    // The host's wire-assembly tests must assert that an in-flight download's
    // assembled row carries a non-null version; protocol tests cannot observe
    // host construction and must not retire that suspicion.
    for (const managedInstallState of [
      { status: "downloading" as const, percent: 50, version: "1.2.3" },
      { status: "installed" as const, version: "1.2.3" },
    ]) {
      const response = providersListResponseSchema.parse({
        providers: [
          {
            ...v8ProviderState("codex"),
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
        8,
        7,
        response,
      );
      expect(downgraded.ok).toBe(true);
      if (!downgraded.ok) continue;
      expect(downgraded.value.providers[0].managedInstallState).not.toHaveProperty(
        "version",
      );
    }
  });
});

describe("v8 per-pack RPC contracts", () => {
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

describe("v8 provider-pack schema distinctions", () => {
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
      ...v8ProviderState("claude-code"),
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
      ...v8ProviderState("claude-code"),
      managedVersions: MANAGED_VERSIONS,
      managedVersionsUnavailable: { reason: "reason-from-a-newer-host" },
    });
    expect(parsed.managedVersionsUnavailable).toBeNull();
    expect(parsed.managedVersions).not.toBeNull();
  });
});
