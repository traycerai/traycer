import { describe, expect, it } from "vitest";
import {
  downgradeRequestAcrossMajors,
  downgradeResponseAcrossMajors,
  upgradeResponseToVersion,
} from "@traycer/protocol/framework/versioned-rpc";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  providerCliStateSchema,
  providerCliStateSchemaV70,
  providerIdSchema,
  providerIdSchemaV70,
  providerLoginCapabilitySchemaV70,
  providerManagedInstallErrorReasonSchemaV70,
  providerManagedInstallStateSchemaV70,
  providersListRequestSchema,
  providersListRequestSchemaV70,
  providersListResponseSchema,
  providersListResponseSchemaV60,
  providersListResponseSchemaV70,
} from "@traycer/protocol/host/provider-schemas";

/**
 * Pins the `providers.list@7.0` freeze (the v7.0 line's wire shapes were
 * hand-copied off the live schemas instead of aliased to them - see the
 * freeze comment on `providerCliStateBaseShapeV70` in `provider-schemas.ts`).
 * Before this freeze, `providersListV70` in `registry.ts` pointed at the
 * live/canonical `providersListRequestSchema` / `providersListResponseSchema`,
 * so the next field added to the canonical shape would silently ride the
 * already-negotiable v7.0 contract - exactly the defect that made v5.0
 * (`omp`) and v6.0 (the provider-pack-registry fields) require a RETROACTIVE
 * freeze after a release tag caught the leak. v7.0 is frozen before it ships,
 * so the next batch of fields (`packId`, `managedVersions`, `nextRunBinary`, a
 * `version` on `managedInstallState`) must open v8.0 instead.
 *
 * A freeze with no test is not a freeze: every test below fails if the source
 * regresses to pointing v7.0 at a live schema/enum/union again.
 */

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
  };
}

// ── 1. Key-set pin, stated literally ────────────────────────────────────────
// Every array here is HAND-WRITTEN, not derived from the canonical schema's
// `.shape` - deriving it from the live schema is exactly the bug this freeze
// exists to catch, and a derived expectation would stay green through the
// leak it is supposed to detect.

const EXPECTED_PROVIDER_CLI_STATE_V70_KEYS = [
  "providerId",
  "enabled",
  "disabledBy",
  "selected",
  "candidates",
  "authPending",
  "checkedAt",
  "apiKey",
  "terminalAgentArgs",
  "envOverrides",
  "loginCapability",
  "availabilityPending",
  "profiles",
  "managedInstallState",
  "versionVisibility",
  "advisory",
  "cliBinaryResolved",
  "auth",
  "nativeCapabilities",
].sort();

const EXPECTED_PROVIDERS_LIST_REQUEST_V70_KEYS = [
  "forceAuthRefresh",
  "native",
].sort();

const EXPECTED_PROVIDERS_LIST_RESPONSE_V70_KEYS = ["providers", "native"].sort();

// Hand-written, same discipline as the key-set arrays above and for the same
// reason: deriving this from `providerIdSchema.options` would stay green
// through a 20th id silently joining the frozen v7.0 enum - exactly the
// `omp`-on-v5.0 defect this whole freeze exists to stop from recurring.
const EXPECTED_PROVIDER_ID_V70_OPTIONS = [
  "claude-code",
  "codex",
  "opencode",
  "cursor",
  "traycer",
  "grok",
  "qwen",
  "kiro",
  "droid",
  "kimi",
  "copilot",
  "kilocode",
  "openrouter",
  "amp",
  "devin",
  "pi",
  "hermes",
  "omp",
  "huggingface",
].sort();

describe("providers.list@7.0 key-set pin (literal, not derived)", () => {
  it("providerCliStateSchemaV70 has exactly these 19 keys", () => {
    expect(Object.keys(providerCliStateSchemaV70.shape).sort()).toEqual(
      EXPECTED_PROVIDER_CLI_STATE_V70_KEYS,
    );
  });

  it("providersListRequestSchemaV70 has exactly these keys", () => {
    expect(Object.keys(providersListRequestSchemaV70.shape).sort()).toEqual(
      EXPECTED_PROVIDERS_LIST_REQUEST_V70_KEYS,
    );
  });

  it("providersListResponseSchemaV70 has exactly these keys", () => {
    expect(Object.keys(providersListResponseSchemaV70.shape).sort()).toEqual(
      EXPECTED_PROVIDERS_LIST_RESPONSE_V70_KEYS,
    );
  });

  it("providerIdSchemaV70 has exactly these 19 ids", () => {
    expect([...providerIdSchemaV70.options].sort()).toEqual(
      EXPECTED_PROVIDER_ID_V70_OPTIONS,
    );
  });
});

// ── 2. v7.0 is decoupled from the canonical schema ──────────────────────────

describe("v7.0 schemas are distinct objects from the canonical live schemas", () => {
  it("providersListRequestSchemaV70 / ResponseSchemaV70 are not the canonical exports", () => {
    expect(providersListRequestSchemaV70).not.toBe(providersListRequestSchema);
    expect(providersListResponseSchemaV70).not.toBe(providersListResponseSchema);
  });

  it("the registered v7.0 RPC contract names the frozen schemas, not the canonical ones", () => {
    const contract = hostRpcRegistry["providers.list"][7].versions[0].contract;
    expect(contract.requestSchema).toBe(providersListRequestSchemaV70);
    expect(contract.responseSchema).toBe(providersListResponseSchemaV70);
    expect(contract.requestSchema).not.toBe(providersListRequestSchema);
    expect(contract.responseSchema).not.toBe(providersListResponseSchema);
  });

  it("providerIdSchemaV70 includes huggingface, the sole v7.0-only provider id", () => {
    expect(providerIdSchemaV70.options).toContain("huggingface");
  });

  // The LIVE side had no guard. `EXPECTED_PROVIDER_ID_V70_OPTIONS` pins the
  // frozen enum, so a stray id joining THAT is caught - but a 20th id joining
  // the live enum failed nothing, and `downgradeProviderCliStateListToV70`
  // simply drops the row: the provider disappears from a v7.0 peer's list with
  // no signal anywhere.
  //
  // Dropping may well be the right answer for a provider a v7.0 client cannot
  // represent. The point is that it must be a DECISION. Adding a harness now
  // fails here until someone states, in this file, which side the new id
  // belongs on.
  it("the live and frozen provider id sets have not drifted apart", () => {
    expect([...providerIdSchema.options].sort()).toEqual(
      [...providerIdSchemaV70.options].sort(),
    );
  });
});

// The live schema now models the concrete v8.0 additions. These tests keep the
// contrast real: the same payload is accepted by the live schema and loses
// the new fields only when decoded through the frozen v7.0 schema.
describe("v7.0 does not track the live shape forward", () => {
  it("drops the new v8.0 provider-row fields (packId, managedVersions, nextRunBinary)", () => {
    const v8ShapedRow = {
      ...providerState("claude-code"),
      profiles: [],
      packId: "pack-claude-code",
      managedVersions: {
        autoDownload: true,
        pinnedVersion: null,
        updateAvailable: null,
        sharedWithProviders: ["codex"],
        totalSizeBytes: null,
        available: [
          {
            version: "1.2.3",
            sizeBytes: null,
            certification: "uncertified",
            recommended: true,
            current: true,
            installState: { status: "installed" },
          },
        ],
      },
      nextRunBinary: {
        kind: "managed",
        path: "/managed/claude-code/1.2.3/bin",
        version: "1.2.3",
      },
    };
    expect(providerCliStateSchema.parse(v8ShapedRow)).toMatchObject({
      packId: "pack-claude-code",
      managedVersions: { sharedWithProviders: ["codex"] },
      nextRunBinary: {
        path: "/managed/claude-code/1.2.3/bin",
        version: "1.2.3",
      },
    });
    const parsed = providerCliStateSchemaV70.parse(v8ShapedRow);
    expect(parsed).not.toHaveProperty("packId");
    expect(parsed).not.toHaveProperty("managedVersions");
    expect(parsed).not.toHaveProperty("nextRunBinary");
  });

  it("drops the new v8.0 `version` addition to managedInstallState's downloading/installed arms", () => {
    const v8ShapedRow = {
      ...providerState("codex"),
      profiles: [],
      managedInstallState: { status: "installed", version: "1.2.3" },
    };
    const parsed = providerCliStateSchemaV70.parse(v8ShapedRow);
    expect(parsed.managedInstallState).toEqual({ status: "installed" });
    expect(parsed.managedInstallState).not.toHaveProperty("version");

    const downloadingRow = {
      ...providerState("codex"),
      profiles: [],
      managedInstallState: { status: "downloading", percent: 50, version: "1.2.3" },
    };
    const parsedDownloading = providerCliStateSchemaV70.parse(downloadingRow);
    expect(parsedDownloading.managedInstallState).toEqual({
      status: "downloading",
      percent: 50,
    });
  });
});

// ── 3. The freeze is behaviour-preserving ───────────────────────────────────

const FULLY_POPULATED_PROFILE = {
  profileId: "profile-1",
  kind: "managed" as const,
  authType: "oauth" as const,
  label: "Work",
  auth: {
    status: "authenticated" as const,
    badgeText: "OK",
    label: "Signed in",
    detail: null,
  },
  identity: { email: "a@example.com", tier: "pro", accountUuid: "uuid-1" },
  usageUpdatedAt: 1_700_000_000_000,
  rateLimitStatus: "near_limit" as const,
  rateLimitLimitedScopes: [
    { family: "sonnet", severity: "near_limit" as const },
  ],
  duplicateOfProfileId: "profile-0",
  ambientDriftNotice: {
    previousEmail: "old@example.com",
    changedAt: 1_699_999_999_999,
  },
  accentColor: "#ef4444" as const,
  reusedTombstone: { label: "Old", accentColor: "#f97316" as const },
};

function fullyPopulatedProviderState(providerId: string) {
  return {
    providerId,
    enabled: true,
    disabledBy: { userId: "u1", handle: "hardik", at: 1_700_000_000_000 },
    selected: { kind: "custom" as const, path: "/usr/local/bin/foo" },
    candidates: [
      {
        kind: "bundled" as const,
        path: "/bundled/foo",
        version: "1.0.0",
        available: true,
        versionPending: false,
      },
      {
        kind: "path" as const,
        path: "/usr/bin/foo",
        version: null,
        available: false,
        versionPending: true,
      },
    ],
    authPending: false,
    checkedAt: 1_700_000_000_000,
    apiKey: { supported: true, configured: true, source: "stored" as const },
    terminalAgentArgs: "--verbose",
    envOverrides: [
      { key: "FOO", value: "bar" },
      { key: "BAZ", value: null },
    ],
    loginCapability: {
      oauthArgs: ["login"],
      token: { vars: ["API_KEY"] },
      codePaste: {},
      terminalLogin: {},
    },
    availabilityPending: false,
    profiles: [FULLY_POPULATED_PROFILE],
    managedInstallState: {
      status: "error" as const,
      reason: "network" as const,
      message: "registry unreachable",
      retryAtMs: 1_700_000_000_000,
    },
    versionVisibility: { differingSessionCount: 2 },
    advisory: { kind: "yank-rollback" as const, detail: "channel yanked" },
    cliBinaryResolved: true,
    auth: {
      status: "authenticated" as const,
      badgeText: "Signed in",
      label: "Provider label",
      detail: null,
    },
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  };
}

const NATIVE_RESULT_SAMPLE = {
  ok: true as const,
  kind: "skills" as const,
  skills: [],
};

describe("v7.0 is behaviour-preserving for what it already serializes", () => {
  it("round-trips a fully-populated ProviderCliState (every optional present) with no loss, huggingface included", () => {
    const canonical = providerCliStateSchema.parse(
      fullyPopulatedProviderState("huggingface"),
    );
    const viaLive = providersListResponseSchema.parse({
      providers: [canonical],
      native: NATIVE_RESULT_SAMPLE,
    });
    const viaFrozen = providersListResponseSchemaV70.parse({
      providers: [canonical],
      native: NATIVE_RESULT_SAMPLE,
    });
    expect(viaFrozen).toEqual(viaLive);
    expect(viaFrozen.providers[0].providerId).toBe("huggingface");
    expect(viaFrozen.providers[0].loginCapability?.terminalLogin).toEqual({});
    expect(viaFrozen.providers[0].managedInstallState).toEqual({
      status: "error",
      reason: "network",
      message: "registry unreachable",
      retryAtMs: 1_700_000_000_000,
    });
    expect(viaFrozen.providers[0].profiles).toEqual([FULLY_POPULATED_PROFILE]);
    expect(viaFrozen.native).toEqual(NATIVE_RESULT_SAMPLE);
  });

  it("the request round-trips identically through the canonical and frozen v7.0 schemas", () => {
    const raw = {
      forceAuthRefresh: true,
      native: {
        kind: "skills" as const,
        providerId: "claude-code" as const,
        scope: "global" as const,
        workspaceRoot: null,
      },
    };
    expect(providersListRequestSchemaV70.parse(raw)).toEqual(
      providersListRequestSchema.parse(raw),
    );
  });
});

// ── 4. Downgrade bridges still work unchanged ───────────────────────────────

describe("downgrade bridges v7.0 -> v6.0..v1.0 still work through the real registry", () => {
  const state = providerCliStateSchema.parse(providerState("claude-code"));

  it.each([6, 5, 4, 3, 2, 1] as const)(
    "response downgrades to v%i.0 without failing",
    (target) => {
      const downgraded = downgradeResponseAcrossMajors(
        hostRpcRegistry["providers.list"],
        7,
        target,
        { providers: [state], native: null },
      );
      expect(downgraded.ok).toBe(true);
    },
  );

  it.each([6, 5, 4, 3, 2, 1] as const)(
    "request downgrades to v%i.0, stripping native (only v7.0 models it)",
    (target) => {
      const canonical = providersListRequestSchemaV70.parse({
        forceAuthRefresh: true,
        native: null,
      });
      const downgraded = downgradeRequestAcrossMajors(
        hostRpcRegistry["providers.list"],
        7,
        target,
        canonical,
      );
      expect(downgraded.ok).toBe(true);
      if (!downgraded.ok) return;
      expect(downgraded.value).not.toHaveProperty("native");
    },
  );

  it("huggingface never survives a downgrade past v6.0 (frozen enum boundary)", () => {
    const huggingfaceState = providerCliStateSchema.parse(
      providerState("huggingface"),
    );
    for (const target of [6, 5, 4, 3, 2, 1] as const) {
      const downgraded = downgradeResponseAcrossMajors(
        hostRpcRegistry["providers.list"],
        7,
        target,
        { providers: [huggingfaceState], native: null },
      );
      expect(downgraded.ok).toBe(true);
      if (!downgraded.ok) continue;
      expect(downgraded.value.providers).toHaveLength(0);
    }
  });
});

describe("upgrade bridge v6.0 -> v7.0 still fills native / registry fields / terminalLogin", () => {
  it("fills honest defaults for an old v6.0 caller, and the fill validates against the frozen v7.0 schema", () => {
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["providers.list"],
      { major: 6, minor: 0 },
      { major: 7, minor: 0 },
      providersListResponseSchemaV60.parse({
        providers: [providerState("copilot")],
      }),
    );
    expect(upgraded.native).toBeNull();
    expect(upgraded.providers[0].managedInstallState).toBeNull();
    expect(upgraded.providers[0].versionVisibility).toBeNull();
    expect(upgraded.providers[0].advisory).toBeNull();
    expect(upgraded.providers[0].loginCapability).toBeNull();
    // The more precise assertion the freeze enables: the upgraded payload is
    // a valid v7.0 wire, not just a valid canonical one.
    expect(() => providersListResponseSchemaV70.parse(upgraded)).not.toThrow();
  });
});

// ── 5. The sub-schema pins bite ─────────────────────────────────────────────

// Titled carefully: the LIVE union rejects these same inputs today too (it
// doesn't model a "paused" arm or an unmodelled reason either), so this is
// not yet a contrast test - it's a pin. The job these tests do is keep
// REJECTING them after the live union starts accepting them (a `paused` arm,
// a new reason), which the analogous "growth" tests above (packId,
// managedVersions, version) demonstrate concretely for the sibling schemas.
describe("providerManagedInstallStateSchemaV70 pins the v7.0 arm and reason sets", () => {
  it("rejects a fifth status arm", () => {
    expect(
      providerManagedInstallStateSchemaV70.safeParse({ status: "paused" })
        .success,
    ).toBe(false);
  });

  it("rejects an unmodeled error reason", () => {
    expect(
      providerManagedInstallStateSchemaV70.safeParse({
        status: "error",
        reason: "some-future-reason",
        message: "boom",
        retryAtMs: null,
      }).success,
    ).toBe(false);
  });

  // Hand-written, same discipline as EXPECTED_PROVIDER_ID_V70_OPTIONS and for
  // the same reason: the acceptance loop below iterates `.options`, so it is
  // derived. A ninth reason silently joining the FROZEN enum keeps that loop
  // green and keeps every key-set test in this file green, and the only other
  // guard is the regenerable JSON-Schema fixture. The consequence of a leak is
  // named in `provider-schemas.ts`: a v7.0 peer `.catch(null)`s the whole
  // `managedInstallState`, so a stuck install renders as a row with no
  // message at all.
  it("pins the eight frozen reasons literally", () => {
    expect([...providerManagedInstallErrorReasonSchemaV70.options].sort()).toEqual(
      [
        "disk-full",
        "live-owner-stalled",
        "local-storage-mismatch",
        "network",
        "trust-unavailable",
        "unknown",
        "unrepairable",
        "verification",
      ].sort(),
    );
  });

  it("still accepts every reason it does model", () => {
    for (const reason of providerManagedInstallErrorReasonSchemaV70.options) {
      expect(
        providerManagedInstallStateSchemaV70.safeParse({
          status: "error",
          reason,
          message: "boom",
          retryAtMs: null,
        }).success,
      ).toBe(true);
    }
  });
});

// Same caveat as the managedInstallState pin above: `biometric` isn't
// modelled by the LIVE capability schema either, so this pins the v7.0 key
// set rather than contrasting it against a live schema that currently
// accepts more. It stays meaningful the same way: once a real fifth
// capability field lands live (the way `terminalLogin` did on v7.0 itself),
// this frozen copy must keep stripping it.
describe("providerLoginCapabilitySchemaV70 pins its four-key capability set", () => {
  it("strips an unmodeled capability key on parse instead of carrying it through", () => {
    const parsed = providerLoginCapabilitySchemaV70.parse({
      oauthArgs: ["login"],
      token: null,
      codePaste: null,
      terminalLogin: null,
      biometric: {},
    });
    expect(parsed).not.toHaveProperty("biometric");
    expect(Object.keys(parsed).sort()).toEqual(
      ["codePaste", "oauthArgs", "terminalLogin", "token"].sort(),
    );
  });
});
