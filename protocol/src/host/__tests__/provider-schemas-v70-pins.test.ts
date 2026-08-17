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
 * Pins the `providersList*SchemaV70` family - the v7-era wire shapes, hand-
 * copied off the live schemas instead of aliased to them (see the freeze
 * comment on `providerCliStateBaseShapeV70` in `provider-schemas.ts`).
 *
 * These shapes BACK NO CONTRACT any more, and that is worth stating plainly
 * because the file reads as if they do. They were frozen when the version-
 * manager fields opened a v8.0 above an unreleased v7.0, so that growing the
 * live shape could not reach the v7.0 contract. The release collapsed those
 * two tree-only majors back into one: v7.0 is the head again and points at the
 * canonical schemas, and the pre-image these exports capture was negotiated by
 * no peer, ever.
 *
 * What still makes them worth pinning is that the provider compat suites and
 * `rate-limit/schemas.ts` parse through them as the shared "v7-era" shape, and
 * several of them (`providerCliStateBaseShapeV70`) still reference live sub-
 * schemas. A pin is what stops live growth from silently redefining what those
 * callers assert.
 *
 * The PRE-SHIP freeze this file used to provide for v7.0 now lives in
 * `__tests__/__fixtures__/frozen-catalog-lines.ts`, which dumps the live shape
 * deeply under the `providers.list@7.0` key: any growth of the head line goes
 * red there and forces v8.0 to be opened for real.
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

const EXPECTED_PROVIDERS_LIST_RESPONSE_V70_KEYS = [
  "providers",
  "native",
].sort();

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

// ── 2. the v7-era pins are distinct objects from the canonical schema ───────

describe("the v7-era schemas are distinct objects from the canonical live ones", () => {
  it("providersListRequestSchemaV70 / ResponseSchemaV70 are not the canonical exports", () => {
    expect(providersListRequestSchemaV70).not.toBe(providersListRequestSchema);
    expect(providersListResponseSchemaV70).not.toBe(
      providersListResponseSchema,
    );
  });

  it("the registered v7.0 RPC contract names the canonical schemas, being the head", () => {
    // The inverse of what this test asserted while a v8.0 sat above v7.0.
    // Collapsing that unreleased major made v7.0 the head again, and the head
    // is the one line that tracks live - so the v7-era pins below back no
    // contract at all. Stated as an assertion rather than left implicit,
    // because "a line that has STOPPED being the head still points at live" is
    // the actual defect the freeze rule exists to catch, and telling the two
    // apart is the whole judgement.
    const contract = hostRpcRegistry["providers.list"][7].versions[0].contract;
    expect(contract.requestSchema).toBe(providersListRequestSchema);
    expect(contract.responseSchema).toBe(providersListResponseSchema);
    expect(contract.requestSchema).not.toBe(providersListRequestSchemaV70);
    expect(contract.responseSchema).not.toBe(providersListResponseSchemaV70);
  });

  it("providerIdSchemaV70 includes huggingface, the sole v7.0-only provider id", () => {
    expect(providerIdSchemaV70.options).toContain("huggingface");
  });

  // The LIVE side had no guard. `EXPECTED_PROVIDER_ID_V70_OPTIONS` pins the
  // frozen enum, so a stray id joining THAT is caught - but a 20th id joining
  // the live enum failed nothing, and the v7-era reparse simply drops the row,
  // so a provider disappears from anything reading through this shape with no
  // signal anywhere.
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

// The version-manager fields ride the LIVE schema, which `providers.list@7.0`
// now binds directly - the release collapsed the unreleased v8.0 that used to
// carry them into v7.0. `providerCliStateSchemaV70` survives as the v7.0-SHAPED
// PIN that the older bridges and compat suites parse through, not as the v7.0
// wire. These tests keep that contrast real: the same payload is accepted by
// the live schema and loses the fields only when decoded through the pin.
describe("the v7.0 pin does not track the live shape forward", () => {
  it("drops the live provider-row fields (packId, managedVersions, nextRunBinary)", () => {
    const liveShapedRow = {
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
    expect(providerCliStateSchema.parse(liveShapedRow)).toMatchObject({
      packId: "pack-claude-code",
      managedVersions: { sharedWithProviders: ["codex"] },
      nextRunBinary: {
        path: "/managed/claude-code/1.2.3/bin",
        version: "1.2.3",
      },
    });
    const parsed = providerCliStateSchemaV70.parse(liveShapedRow);
    expect(parsed).not.toHaveProperty("packId");
    expect(parsed).not.toHaveProperty("managedVersions");
    expect(parsed).not.toHaveProperty("nextRunBinary");
  });

  it("drops the live `version` addition to managedInstallState's downloading/installed arms", () => {
    const liveShapedRow = {
      ...providerState("codex"),
      profiles: [],
      managedInstallState: { status: "installed", version: "1.2.3" },
    };
    const parsed = providerCliStateSchemaV70.parse(liveShapedRow);
    expect(parsed.managedInstallState).toEqual({ status: "installed" });
    expect(parsed.managedInstallState).not.toHaveProperty("version");

    const downloadingRow = {
      ...providerState("codex"),
      profiles: [],
      managedInstallState: {
        status: "downloading",
        percent: 50,
        version: "1.2.3",
      },
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
    // The frozen capability descriptor predates `modelProviders`, so that key
    // is the ONE difference the frozen parse may introduce - everything else
    // must round-trip untouched.
    const { modelProviders: _modelProviders, ...liveCapabilities } =
      viaLive.providers[0].nativeCapabilities;
    expect(viaFrozen).toEqual({
      ...viaLive,
      providers: [
        { ...viaLive.providers[0], nativeCapabilities: liveCapabilities },
      ],
    });
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
        providersListResponseSchema.parse({
          providers: [state],
          native: null,
        }),
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
        providersListResponseSchema.parse({
          providers: [huggingfaceState],
          native: null,
        }),
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
    expect(
      [...providerManagedInstallErrorReasonSchemaV70.options].sort(),
    ).toEqual(
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
