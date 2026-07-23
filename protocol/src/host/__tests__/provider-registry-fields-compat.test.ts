import { describe, expect, it } from "vitest";
import {
  downgradeResponseAcrossMajors,
  upgradeResponseToVersion,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  downgradeProviderCliStateToV10,
  providerAdvisoryKindSchema,
  providerAdvisorySchema,
  providerCliStateSchema,
  providerCliStateSchemaV10,
  providerCliStateSchemaV20,
  providerCliStateSchemaV30,
  providerManagedInstallStateSchema,
  providerMutationCliStateSchemaV20,
  providerMutationCliStateSchemaV21,
  providerVersionVisibilitySchema,
  providersListResponseSchemaV20,
  providersListResponseSchemaV30,
  providersSetEnabledResponseSchema,
} from "@traycer/protocol/host/provider-schemas";

/**
 * Provider pack registry protocol ticket coverage (T3): the managed-install
 * lifecycle, aggregated version-visibility, and dormant Phase-2 advisory
 * fields are additive on the live `ProviderCliState` shape only - a host that
 * predates the provider pack registry (or any already-frozen v1.0/v2.0/v3.0
 * wire line) never carries them, and every downgrade bridge that targets a
 * frozen/strict pre-registry wire shape must strip the new fields instead of
 * failing the parse.
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

describe("provider-pack-registry fields default for old (pre-registry) hosts", () => {
  it("providerCliStateSchema total-decodes a genuinely missing key to undefined, never throwing", () => {
    // `.optional()` keeps the key itself omittable in a TS object literal (so
    // host-side construction sites that predate this ticket don't need to be
    // touched); a caller that hasn't populated it yet should read this the
    // same as an explicit null (see the renderer's `?? null` normalization).
    const parsed = providerCliStateSchema.parse(providerState("claude-code"));
    expect(parsed.managedInstallState).toBeUndefined();
    expect(parsed.versionVisibility).toBeUndefined();
    expect(parsed.advisory).toBeUndefined();
  });

  it("providerCliStateSchema parses an explicit null for each field", () => {
    const parsed = providerCliStateSchema.parse({
      ...providerState("codex"),
      managedInstallState: null,
      versionVisibility: null,
      advisory: null,
    });
    expect(parsed.managedInstallState).toBeNull();
    expect(parsed.versionVisibility).toBeNull();
    expect(parsed.advisory).toBeNull();
  });

  it("tolerates an unknown future managedInstallState/advisory shape by falling back to null, never throwing", () => {
    const parsed = providerCliStateSchema.parse({
      ...providerState("codex"),
      managedInstallState: { status: "some-future-status" },
      advisory: { kind: "some-future-kind", detail: null },
    });
    expect(parsed.managedInstallState).toBeNull();
    expect(parsed.advisory).toBeNull();
  });
});

describe("providerManagedInstallStateSchema", () => {
  it("accepts absent/downloading/installed and rejects an out-of-range percent", () => {
    expect(
      providerManagedInstallStateSchema.safeParse({ status: "absent" }).success,
    ).toBe(true);
    expect(
      providerManagedInstallStateSchema.safeParse({
        status: "downloading",
        percent: 42,
      }).success,
    ).toBe(true);
    expect(
      providerManagedInstallStateSchema.safeParse({ status: "installed" })
        .success,
    ).toBe(true);
    expect(
      providerManagedInstallStateSchema.safeParse({
        status: "downloading",
        percent: 142,
      }).success,
    ).toBe(false);
  });
});

describe("providerVersionVisibilitySchema", () => {
  it("accepts a nonnegative differingSessionCount and rejects a negative one", () => {
    expect(
      providerVersionVisibilitySchema.safeParse({ differingSessionCount: 0 })
        .success,
    ).toBe(true);
    expect(
      providerVersionVisibilitySchema.safeParse({ differingSessionCount: 3 })
        .success,
    ).toBe(true);
    expect(
      providerVersionVisibilitySchema.safeParse({ differingSessionCount: -1 })
        .success,
    ).toBe(false);
  });
});

describe("providerAdvisorySchema (Phase-2 dormant vocabulary)", () => {
  it("accepts every dormant advisory kind", () => {
    for (const kind of providerAdvisoryKindSchema.options) {
      expect(
        providerAdvisorySchema.safeParse({ kind, detail: null }).success,
      ).toBe(true);
    }
  });

  it("rejects an unmodeled advisory kind", () => {
    expect(
      providerAdvisorySchema.safeParse({
        kind: "not-a-real-kind",
        detail: null,
      }).success,
    ).toBe(false);
  });
});

describe("provider-pack-registry fields downgrade to v1.0", () => {
  it("strips managedInstallState/versionVisibility/advisory before the strict v1.0 parse", () => {
    const state = providerCliStateSchema.parse({
      ...providerState("claude-code"),
      managedInstallState: { status: "downloading", percent: 50 },
      versionVisibility: { differingSessionCount: 2 },
      advisory: { kind: "stale-channel", detail: "channel unreachable" },
    });
    const downgraded = downgradeProviderCliStateToV10(state);
    expect(downgraded).not.toBeNull();
    // `providerCliStateSchemaV10` is a strict object - re-parsing the
    // downgraded value proves none of the new fields survived.
    expect(providerCliStateSchemaV10.safeParse(downgraded).success).toBe(true);
    expect(downgraded).not.toHaveProperty("managedInstallState");
    expect(downgraded).not.toHaveProperty("versionVisibility");
    expect(downgraded).not.toHaveProperty("advisory");
  });

  it("still downgrades a provider with none of the new fields set (old host build)", () => {
    const state = providerCliStateSchema.parse(providerState("codex"));
    const downgraded = downgradeProviderCliStateToV10(state);
    expect(downgraded).not.toBeNull();
    expect(downgraded).not.toHaveProperty("managedInstallState");
    expect(downgraded).not.toHaveProperty("versionVisibility");
    expect(downgraded).not.toHaveProperty("advisory");
  });
});

const stateWithRegistryFields = providerCliStateSchema.parse({
  ...providerState("claude-code"),
  managedInstallState: { status: "installed" },
  versionVisibility: { differingSessionCount: 1 },
  advisory: { kind: "row-incompatibility", detail: null },
});

describe("providers.list latest -> v2.0/v3.0 downgrade strips the new fields", () => {
  it("providerCliStateSchemaV20 drops the unmodeled keys on parse", () => {
    const parsed = providerCliStateSchemaV20.parse(stateWithRegistryFields);
    expect(parsed).not.toHaveProperty("managedInstallState");
    expect(parsed).not.toHaveProperty("versionVisibility");
    expect(parsed).not.toHaveProperty("advisory");
  });

  it("providerCliStateSchemaV30 drops the unmodeled keys on parse", () => {
    const parsed = providerCliStateSchemaV30.parse(stateWithRegistryFields);
    expect(parsed).not.toHaveProperty("managedInstallState");
    expect(parsed).not.toHaveProperty("versionVisibility");
    expect(parsed).not.toHaveProperty("advisory");
  });

  it("latest -> v2.0 downgrade never leaks the new fields to a v2.0 caller", () => {
    const downgraded = downgradeResponseAcrossMajors(
      hostRpcRegistry["providers.list"],
      5,
      2,
      { providers: [stateWithRegistryFields] },
    );
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    expect(downgraded.value.providers[0]).not.toHaveProperty(
      "managedInstallState",
    );
    const parsed = providersListResponseSchemaV20.safeParse(downgraded.value);
    expect(parsed.success).toBe(true);
  });

  it("latest -> v3.0 downgrade never leaks the new fields to a v3.0 caller", () => {
    const downgraded = downgradeResponseAcrossMajors(
      hostRpcRegistry["providers.list"],
      5,
      3,
      { providers: [stateWithRegistryFields] },
    );
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    expect(downgraded.value.providers[0]).not.toHaveProperty(
      "versionVisibility",
    );
    const parsed = providersListResponseSchemaV30.safeParse(downgraded.value);
    expect(parsed.success).toBe(true);
  });
});

describe("providers.list old-host upgrade fills honest defaults for the new fields", () => {
  it("upgrades a pre-registry v3.0 response to v5.0 with the new fields null/false", () => {
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["providers.list"],
      { major: 3, minor: 0 },
      { major: 5, minor: 0 },
      providersListResponseSchemaV30.parse({
        providers: [providerState("amp")],
      }),
    );
    expect(upgraded.providers[0].managedInstallState).toBeNull();
    expect(upgraded.providers[0].versionVisibility).toBeNull();
    expect(upgraded.providers[0].advisory).toBeNull();
  });

  it("upgrades a v2.0 response to v5.0 with the new fields null along the chain", () => {
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["providers.list"],
      { major: 2, minor: 0 },
      { major: 5, minor: 0 },
      providersListResponseSchemaV20.parse({
        providers: [providerState("codex")],
      }),
    );
    expect(upgraded.providers[0].managedInstallState).toBeNull();
    expect(upgraded.providers[0].versionVisibility).toBeNull();
    expect(upgraded.providers[0].advisory).toBeNull();
  });
});

// The provider.* state-echo mutations never carry the registry fields on ANY
// line. Both their released majors are pinned to frozen shapes that don't
// model them, so a host whose in-memory state carries the fields (every host
// after T3) still emits the exact wire a released 2.0/2.1 peer expects. This
// is what `providers.list` - the sole carrier, properly versioned at v5.0 -
// exists for; see `providerMutationCliStateSchemaV21`'s comment.
describe("provider.* mutation lines never carry the provider-pack-registry fields", () => {
  it("providerMutationCliStateSchemaV20 drops the unmodeled keys on parse", () => {
    const parsed = providerMutationCliStateSchemaV20.parse(
      stateWithRegistryFields,
    );
    expect(parsed).not.toHaveProperty("managedInstallState");
    expect(parsed).not.toHaveProperty("versionVisibility");
    expect(parsed).not.toHaveProperty("advisory");
  });

  it("providerMutationCliStateSchemaV21 drops the unmodeled keys on parse but keeps profiles", () => {
    const parsed = providerMutationCliStateSchemaV21.parse({
      ...stateWithRegistryFields,
      profiles: [],
    });
    expect(parsed).not.toHaveProperty("managedInstallState");
    expect(parsed).not.toHaveProperty("versionVisibility");
    expect(parsed).not.toHaveProperty("advisory");
    // `profiles` DID ship on the 2.1 line - the pin freezes that wire as
    // released, it doesn't roll it back to 2.0.
    expect(parsed.profiles).toEqual([]);
  });

  it("upgrades a released 2.0 setSelection response to 2.1 without inventing the fields", () => {
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["providers.setSelection"],
      { major: 2, minor: 0 },
      { major: 2, minor: 1 },
      {
        state: providerMutationCliStateSchemaV20.parse(
          providerState("claude-code"),
        ),
      },
    );
    expect(upgraded.state).not.toHaveProperty("managedInstallState");
    expect(upgraded.state).not.toHaveProperty("versionVisibility");
    expect(upgraded.state).not.toHaveProperty("advisory");
    expect(upgraded.state.profiles).toEqual([]);
  });

  it("upgrades a released 2.0 awaitLogin response to 2.1 without inventing the fields (including the null-state branch)", () => {
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["providers.awaitLogin"],
      { major: 2, minor: 0 },
      { major: 2, minor: 1 },
      {
        state: providerMutationCliStateSchemaV20.parse(
          providerState("claude-code"),
        ),
      },
    );
    expect(upgraded.state).not.toHaveProperty("managedInstallState");
    expect(upgraded.state).not.toHaveProperty("versionVisibility");
    expect(upgraded.state).not.toHaveProperty("advisory");

    const upgradedNull = upgradeResponseToVersion(
      hostRpcRegistry["providers.awaitLogin"],
      { major: 2, minor: 0 },
      { major: 2, minor: 1 },
      { state: null },
    );
    expect(upgradedNull.state).toBeNull();
  });

  // The regression this pin exists to stop: the host builds ONE live-shaped
  // state (`toWire`) and echoes it from both `providers.list` and every
  // mutation, so the mutation response schema is the only thing standing
  // between the registry fields and an already-released 2.1 wire that never
  // carried them (cli-/host-v1.1.7 negotiate 2.1). This schema is what
  // `providersSetEnabledV21` is wired to.
  it("strips the fields from a live-shaped host echo at the 2.1 wire boundary", () => {
    const onWire = providersSetEnabledResponseSchema.parse({
      state: stateWithRegistryFields,
    });
    expect(onWire.state).not.toHaveProperty("managedInstallState");
    expect(onWire.state).not.toHaveProperty("versionVisibility");
    expect(onWire.state).not.toHaveProperty("advisory");
  });
});
