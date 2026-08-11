import { describe, expect, it } from "vitest";
import {
  downgradeResponseAcrossMajors,
  upgradeResponseToVersion,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  downgradeProviderCliStateToV10,
  providerAdvisoryKindSchema,
  providerAdvisorySchema,
  providerCliStateSchema,
  providerCliStateSchemaV10,
  providerCliStateSchemaV20,
  providerCliStateSchemaV30,
  providerManagedInstallErrorReasonSchema,
  providerManagedInstallStateSchema,
  providerMutationCliStateSchemaV20,
  providerMutationCliStateSchemaV21,
  providerLoginCapabilitySchema,
  providerLoginCapabilitySchemaV40,
  providerVersionVisibilitySchema,
  providersEnsurePackRequestSchema,
  providersEnsurePackResponseSchema,
  providersListResponseSchema,
  providersListResponseSchemaV20,
  providersListResponseSchemaV30,
  providersListResponseSchemaV40,
  providersListResponseSchemaV50,
  providersListResponseSchemaV60,
  providersSetEnabledResponseSchema,
  providersStartTerminalLoginRequestSchema,
  providersStartTerminalLoginResponseSchema,
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

describe("cliBinaryResolved additive field (binary-absent explanation)", () => {
  it("total-decodes a genuinely missing key to undefined, never throwing", () => {
    // An old host omits the key; the client reads undefined as "true" (no
    // notice) via `?? true` / the field's quiet default. A throw here would
    // drop every provider on an old host.
    const parsed = providerCliStateSchema.parse(providerState("claude-code"));
    expect(parsed.cliBinaryResolved).toBeUndefined();
  });

  it("catches a garbage value to true rather than throwing", () => {
    // `.catch(true)` is the backward-safety half: a mid-rollout host sending
    // a non-boolean must not break providers.list for every client.
    for (const garbage of ["yes", null, 1, {}] as const) {
      const parsed = providerCliStateSchema.parse({
        ...providerState("cursor"),
        cliBinaryResolved: garbage,
      });
      expect(parsed.cliBinaryResolved).toBe(true);
    }
  });

  it("parses an explicit false and true", () => {
    expect(
      providerCliStateSchema.parse({
        ...providerState("cursor"),
        cliBinaryResolved: false,
      }).cliBinaryResolved,
    ).toBe(false);
    expect(
      providerCliStateSchema.parse({
        ...providerState("cursor"),
        cliBinaryResolved: true,
      }).cliBinaryResolved,
    ).toBe(true);
  });

  it("downgradeProviderCliStateToV10 strips the key so the strict v1.0 parse still returns a state", () => {
    // providerCliStateSchemaV10 is a strictObject. A missed strip silently
    // drops EVERY provider for v1.0 clients - the key is unknown and the
    // whole row fails the parse. Use a pre-v2.0 provider id so the frozen
    // v1.0 providerId enum accepts the row after the strip.
    const state = providerCliStateSchema.parse({
      ...providerState("cursor"),
      cliBinaryResolved: false,
    });
    const downgraded = downgradeProviderCliStateToV10(state);
    expect(downgraded).not.toBeNull();
    expect(providerCliStateSchemaV10.safeParse(downgraded).success).toBe(true);
    expect(downgraded).not.toHaveProperty("cliBinaryResolved");
  });

  it("v2.0 and v3.0 frozen shapes drop the unmodeled key on parse", () => {
    // cursor is on every frozen providerId enum; amp is not (post-v2.0).
    const state = providerCliStateSchema.parse({
      ...providerState("cursor"),
      cliBinaryResolved: false,
    });
    const v20 = providerCliStateSchemaV20.parse(state);
    const v30 = providerCliStateSchemaV30.parse(state);
    expect(v20).not.toHaveProperty("cliBinaryResolved");
    expect(v30).not.toHaveProperty("cliBinaryResolved");
  });

  it("latest -> v2.0/v3.0 list downgrades never leak cliBinaryResolved", () => {
    const state = providerCliStateSchema.parse({
      ...providerState("codex"),
      cliBinaryResolved: false,
    });
    for (const target of [2, 3] as const) {
      const downgraded = downgradeResponseAcrossMajors(
        hostRpcRegistry["providers.list"],
        7,
        target,
        { providers: [state], native: null },
      );
      expect(downgraded.ok).toBe(true);
      if (!downgraded.ok) continue;
      expect(downgraded.value.providers[0]).not.toHaveProperty(
        "cliBinaryResolved",
      );
    }
  });
});

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

  // N13: a live sibling host owns the download under a per-cell lease, so this
  // host can see a transfer is in progress but cannot read the owner's
  // in-memory byte counter. `absent` would be a lie; `downloading` with no
  // percent is the honest observer state. If this parse ever fails, the
  // observing host has no way to report the truth at all.
  it("accepts downloading with a null percent (live-sibling observer state)", () => {
    const parsed = providerManagedInstallStateSchema.safeParse({
      status: "downloading",
      percent: null,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual({ status: "downloading", percent: null });
  });

  it("still requires the percent KEY on downloading - null is a value, not an omission", () => {
    expect(
      providerManagedInstallStateSchema.safeParse({ status: "downloading" })
        .success,
    ).toBe(false);
  });

  it("accepts the error arm for every modeled reason, with and without a retry time", () => {
    for (const reason of providerManagedInstallErrorReasonSchema.options) {
      expect(
        providerManagedInstallStateSchema.safeParse({
          status: "error",
          reason,
          message: "boom",
          retryAtMs: 1_700_000_000_000,
        }).success,
      ).toBe(true);
    }
    // No scheduled automatic retry: the cell is stuck until a user-initiated
    // `providers.ensurePack`.
    expect(
      providerManagedInstallStateSchema.safeParse({
        status: "error",
        reason: "verification",
        message: "digest mismatch",
        retryAtMs: null,
      }).success,
    ).toBe(true);
  });

  it("rejects an unmodeled error reason and a partially-populated error arm", () => {
    expect(
      providerManagedInstallStateSchema.safeParse({
        status: "error",
        reason: "not-a-real-reason",
        message: "boom",
        retryAtMs: null,
      }).success,
    ).toBe(false);
    expect(
      providerManagedInstallStateSchema.safeParse({
        status: "error",
        reason: "network",
      }).success,
    ).toBe(false);
  });
});

// The whole point of the additive union: `providers.list@6.0` is the carrier
// line, so the new arms must survive an actual v6.0 response parse rather than
// only the standalone schema's.
describe("the new arms survive the providers.list@6.0 response parse", () => {
  it("carries a null-percent download and a full error arm through the live response schema", () => {
    const parsed = providersListResponseSchema.parse({
      providers: [
        {
          ...providerState("claude-code"),
          profiles: [],
          managedInstallState: { status: "downloading", percent: null },
        },
        {
          ...providerState("codex"),
          profiles: [],
          managedInstallState: {
            status: "error",
            reason: "disk-full",
            message: "ENOSPC writing pack.tar.zst",
            retryAtMs: 1_700_000_000_000,
          },
        },
      ],
    });
    expect(parsed.providers[0].managedInstallState).toEqual({
      status: "downloading",
      percent: null,
    });
    expect(parsed.providers[1].managedInstallState).toEqual({
      status: "error",
      reason: "disk-full",
      message: "ENOSPC writing pack.tar.zst",
      retryAtMs: 1_700_000_000_000,
    });
  });
});

// The accepted residual, asserted rather than merely documented: a client on
// any RELEASED line never sees the `error` arm at all, because every bridge
// down to a released target strips `managedInstallState` wholesale. What it
// renders is the plain `available` fallback - post-T7 a silently-unavailable
// row with no message. The `.catch(null)` path (below) is the narrower case of
// a client that negotiates 6.0 but predates this arm.
describe("old-client behavior on the error arm", () => {
  const erroredState = providerCliStateSchema.parse({
    ...providerState("claude-code"),
    managedInstallState: {
      status: "error",
      reason: "network",
      message: "registry unreachable",
      retryAtMs: 1_700_000_000_000,
    },
  });

  it.each([1, 2, 3, 4, 5, 6] as const)(
    "v7.0 -> v%i.0 strips the error arm instead of failing the downgrade",
    (targetMajor) => {
      const downgraded = downgradeResponseAcrossMajors(
        hostRpcRegistry["providers.list"],
        7,
        targetMajor,
        { providers: [erroredState], native: null },
      );
      expect(downgraded.ok).toBe(true);
      if (!downgraded.ok) return;
      expect(downgraded.value.providers[0]).not.toHaveProperty(
        "managedInstallState",
      );
    },
  );

  // The unrecognized-DISCRIMINATOR half of this story - a 6.0 client whose
  // union has no `error` arm at all - is asserted once, generically, by
  // "tolerates an unknown future managedInstallState/advisory shape" above; it
  // exercises this same field and its same `.catch(null)`, so repeating it here
  // would be a second copy of one guard rather than new coverage. What follows
  // bounds that fallback from the other side, which nothing else covered.
  it("tolerates an additive key on a recognized arm but nulls a malformed one", () => {
    // Why the fallback cannot be read as "any unexpected input nulls the
    // field": each arm is a plain `z.object`, so an unknown EXTRA key is
    // stripped and the arm survives - that is what lets a future arm add a
    // field without blanking this state on every older client.
    const additive = providerCliStateSchema.parse({
      ...providerState("codex"),
      managedInstallState: {
        status: "error",
        reason: "network",
        message: "registry unreachable",
        retryAtMs: null,
        retryAtMs2: "not a number",
      },
    });
    expect(additive.managedInstallState).toEqual({
      status: "error",
      reason: "network",
      message: "registry unreachable",
      retryAtMs: null,
    });

    // A wrong-typed KNOWN key is the opposite: the arm fails to parse, and
    // `.catch(null)` is what stands between it and a thrown response.
    const malformed = providerCliStateSchema.parse({
      ...providerState("codex"),
      managedInstallState: {
        status: "error",
        reason: "network",
        message: "registry unreachable",
        retryAtMs: "later",
      },
    });
    expect(malformed.managedInstallState).toBeNull();
  });

  it("nulls the arm when retryAtMs is not a non-negative integer instant", () => {
    // Guards the tightened `retryAtMs` constraint through the same `.catch(null)`
    // path: a fractional or negative epoch-ms is a producer bug, and degrading
    // to "no retry scheduled" beats surfacing a countdown to a nonsense instant.
    for (const retryAtMs of [-1, 1.5]) {
      const parsed = providerCliStateSchema.parse({
        ...providerState("codex"),
        managedInstallState: {
          status: "error",
          reason: "network",
          message: "registry unreachable",
          retryAtMs,
        },
      });
      expect(parsed.managedInstallState).toBeNull();
    }
  });
});

describe("providers.ensurePack is an additive optional method", () => {
  it("is registered, declares unsupported degradation, and stays out of the released floor", () => {
    const entry = hostRpcRegistry["providers.ensurePack"];
    expect(entry).toBeDefined();
    expect(entry.degrade).toEqual({ kind: "unsupported" });
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain("providers.ensurePack");
  });

  it("accepts a providerId request and a nullable managedInstallState response", () => {
    expect(
      providersEnsurePackRequestSchema.safeParse({ providerId: "claude-code" })
        .success,
    ).toBe(true);
    expect(
      providersEnsurePackRequestSchema.safeParse({
        providerId: "not-a-provider",
      }).success,
    ).toBe(false);
    expect(
      providersEnsurePackResponseSchema.parse({ managedInstallState: null })
        .managedInstallState,
    ).toBeNull();
    expect(
      providersEnsurePackResponseSchema.parse({
        managedInstallState: { status: "downloading", percent: null },
      }).managedInstallState,
    ).toEqual({ status: "downloading", percent: null });
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
      7,
      2,
      { providers: [stateWithRegistryFields], native: null },
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
      7,
      3,
      { providers: [stateWithRegistryFields], native: null },
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
  it("upgrades a pre-registry v3.0 response to v7.0 with the new fields null/false", () => {
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["providers.list"],
      { major: 3, minor: 0 },
      { major: 7, minor: 0 },
      providersListResponseSchemaV30.parse({
        providers: [providerState("amp")],
      }),
    );
    expect(upgraded.providers[0].managedInstallState).toBeNull();
    expect(upgraded.providers[0].versionVisibility).toBeNull();
    expect(upgraded.providers[0].advisory).toBeNull();
  });

  it("upgrades a v2.0 response to v7.0 with the new fields null along the chain", () => {
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["providers.list"],
      { major: 2, minor: 0 },
      { major: 7, minor: 0 },
      providersListResponseSchemaV20.parse({
        providers: [providerState("codex")],
      }),
    );
    expect(upgraded.providers[0].managedInstallState).toBeNull();
    expect(upgraded.providers[0].versionVisibility).toBeNull();
    expect(upgraded.providers[0].advisory).toBeNull();
  });

  it("upgrades a v4.0 response to v7.0 - the path a released host actually takes", () => {
    // The case that was missing, and the only one that runs in the field:
    // `host-v1.1.7` tops out at `providers.list` 4.0. The earlier cases both
    // route through the v3->v4 bridge, which is where the fill used to live -
    // so they passed while the released path filled nothing, because v4.0's
    // frozen target does not model the fields and silently discarded it.
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["providers.list"],
      { major: 4, minor: 0 },
      { major: 7, minor: 0 },
      providersListResponseSchemaV40.parse({
        providers: [{ ...providerState("amp"), profiles: [] }],
      }),
    );
    expect(upgraded.providers[0].managedInstallState).toBeNull();
    expect(upgraded.providers[0].versionVisibility).toBeNull();
    expect(upgraded.providers[0].advisory).toBeNull();
  });

  it("upgrades a v5.0 response to v7.0 across the re-homed fill", () => {
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["providers.list"],
      { major: 5, minor: 0 },
      { major: 7, minor: 0 },
      providersListResponseSchemaV50.parse({
        providers: [{ ...providerState("amp"), profiles: [] }],
      }),
    );
    expect(upgraded.providers[0].managedInstallState).toBeNull();
    expect(upgraded.providers[0].versionVisibility).toBeNull();
    expect(upgraded.providers[0].advisory).toBeNull();
  });

  it("upgrades a v6.0 response to v7.0, where the fill now lives", () => {
    // `cli-v1.1.9` froze v6.0 without the registry fields, so v6->v7 is the
    // first bridge whose target models them - the same reason the fill moved
    // from v3->v4 to v5->v6 when `cli-v1.1.8` froze v5.0.
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["providers.list"],
      { major: 6, minor: 0 },
      { major: 7, minor: 0 },
      providersListResponseSchemaV60.parse({
        providers: [{ ...providerState("amp"), profiles: [] }],
      }),
    );
    expect(upgraded.providers[0].managedInstallState).toBeNull();
    expect(upgraded.providers[0].versionVisibility).toBeNull();
    expect(upgraded.providers[0].advisory).toBeNull();
  });
});

describe("providers.list v6.0 is frozen against the registry fields", () => {
  it("v6.0 does not model them, so a v7.0 -> v6.0 downgrade strips them", () => {
    // `cli-v1.1.9` shipped v6.0 while the registry fields were still growing
    // it - the same defect `cli-v1.1.8` exposed on v5.0, one version later.
    // v6.0 now pins the frozen v4.0 base shape, so a field added to the LIVE
    // base shape cannot reach a client that negotiated v6.0.
    const downgraded = downgradeResponseAcrossMajors(
      hostRpcRegistry["providers.list"],
      7,
      6,
      // `native` is required here and absent from the major-6 cases above
      // because v7.0 is the live response shape, which carries it - v6.0 froze
      // before it existed. Same reason the registry fields only ride v7.0.
      { providers: [stateWithRegistryFields], native: null },
    );
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    expect(downgraded.value.providers[0]).not.toHaveProperty(
      "managedInstallState",
    );
    expect(downgraded.value.providers[0]).not.toHaveProperty(
      "versionVisibility",
    );
    expect(downgraded.value.providers[0]).not.toHaveProperty("advisory");
  });

  it("parses a v6.0 payload that carries the fields by dropping them", () => {
    const parsed = providersListResponseSchemaV60.parse({
      providers: [stateWithRegistryFields],
    });
    expect(parsed.providers[0]).not.toHaveProperty("managedInstallState");
  });

  it("still carries omp to a v6.0 caller - only the registry fields are cut", () => {
    const parsed = providersListResponseSchemaV60.parse({
      providers: [{ ...stateWithRegistryFields, providerId: "omp" }],
    });
    expect(parsed.providers[0].providerId).toBe("omp");
  });
});

describe("providers.list v5.0 is frozen against the registry fields", () => {
  it("v5.0 does not model them, so a v7.0 -> v5.0 downgrade strips them", () => {
    // `cli-v1.1.8` shipped v5.0. Growing it is the same defect class as the
    // original mutation-echo break, on the carrier line itself. v5.0 pins the
    // frozen v4.0 base shape precisely so a field added to the LIVE base shape
    // cannot reach it.
    const downgraded = downgradeResponseAcrossMajors(
      hostRpcRegistry["providers.list"],
      7,
      5,
      { providers: [stateWithRegistryFields], native: null },
    );
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    expect(downgraded.value.providers[0]).not.toHaveProperty(
      "managedInstallState",
    );
    expect(downgraded.value.providers[0]).not.toHaveProperty(
      "versionVisibility",
    );
    expect(downgraded.value.providers[0]).not.toHaveProperty("advisory");
  });

  it("parses a v5.0 payload that carries the fields by dropping them", () => {
    const parsed = providersListResponseSchemaV50.parse({
      providers: [stateWithRegistryFields],
    });
    expect(parsed.providers[0]).not.toHaveProperty("managedInstallState");
  });
});

// The provider.* state-echo mutations never carry the registry fields on ANY
// line. Both their released majors are pinned to frozen shapes that don't
// model them, so a host whose in-memory state carries the fields (every host
// after T3) still emits the exact wire a released 2.0/2.1 peer expects. This
// is what `providers.list` - the sole carrier, properly versioned at v6.0 -
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

/**
 * `terminalLogin` marks a provider whose sign-in must run in a real terminal
 * (Copilot: `copilot login` prints a device code that a headless child
 * discards). It is a v7.0 field, and every already-released `providers.list`
 * line plus every @2.1 mutation echo is backed by the hand-frozen
 * `providerCliStateBaseShapeV40` - whose `loginCapability` is now pinned to
 * `providerLoginCapabilitySchemaV40` rather than the live capability.
 *
 * Both directions are asserted, because either one alone passes for the wrong
 * reason: "the frozen shape strips it" is also true of a schema that never
 * models the field anywhere, and "the live shape keeps it" is also true of a
 * frozen shape that leaks.
 */
describe("terminalLogin is a v7.0-only login capability", () => {
  const capabilityWithTerminalLogin = {
    oauthArgs: ["login"],
    token: null,
    codePaste: null,
    terminalLogin: {},
  };

  it("the live capability keeps terminalLogin", () => {
    const parsed = providerLoginCapabilitySchema.parse(
      capabilityWithTerminalLogin,
    );
    expect(Object.keys(parsed)).toContain("terminalLogin");
    expect(parsed.terminalLogin).toEqual({});
  });

  it("the frozen v4.0 capability strips terminalLogin", () => {
    const parsed = providerLoginCapabilitySchemaV40.parse(
      capabilityWithTerminalLogin,
    );
    expect(Object.keys(parsed)).not.toContain("terminalLogin");
  });

  it.each([
    ["providers.list@4.0", providersListResponseSchemaV40],
    ["providers.list@5.0", providersListResponseSchemaV50],
    ["providers.list@6.0", providersListResponseSchemaV60],
  ])("%s strips terminalLogin from a provider row", (_label, schema) => {
    const parsed = schema.parse({
      providers: [
        {
          ...providerState("copilot"),
          loginCapability: capabilityWithTerminalLogin,
        },
      ],
    });
    const capability = parsed.providers[0].loginCapability;
    expect(capability).not.toBeNull();
    expect(Object.keys(capability ?? {})).not.toContain("terminalLogin");
    // The rest of the capability still rides this line - this is a field
    // freeze, not a capability blackout.
    expect(capability?.oauthArgs).toEqual(["login"]);
  });

  it("the @2.1 mutation state echo strips terminalLogin", () => {
    // Ten released @2.1 echoes share this shape. An echo that carried the
    // field would break a released client for a value a login can never
    // change anyway.
    const parsed = providerMutationCliStateSchemaV21.parse({
      ...providerState("copilot"),
      loginCapability: capabilityWithTerminalLogin,
    });
    expect(Object.keys(parsed.loginCapability ?? {})).not.toContain(
      "terminalLogin",
    );
  });

  it("the live providers.list response keeps terminalLogin", () => {
    const parsed = providersListResponseSchema.parse({
      providers: [
        {
          ...providerState("copilot"),
          loginCapability: capabilityWithTerminalLogin,
        },
      ],
    });
    expect(parsed.providers[0].loginCapability?.terminalLogin).toEqual({});
  });
});

describe("providers.list v6->v7 fills terminalLogin for an old host", () => {
  it("fills null through the REGISTERED bridge, not just a hand-called helper", () => {
    // A client decodes an old host's payload through the negotiated FROZEN
    // schema, so the live `.catch(null)` never runs and the key would arrive
    // genuinely `undefined`. This bridge is the only hop onto the live shape,
    // so it is the only place the fill can happen.
    //
    // Two mechanisms currently produce it: the bridge's explicit
    // `upgradeLoginCapabilityFromV40` call, and the live re-parse inside
    // `upgradeProviderCliStateListToLatest` (which exists for
    // `nativeCapabilities` and incidentally runs `.catch(null)`). This test
    // asserts the OUTCOME, so it stays green while either survives and goes
    // red only if both go - which is the contract worth pinning. Do not read
    // it as proof that either mechanism alone is present.
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["providers.list"],
      { major: 6, minor: 0 },
      { major: 7, minor: 0 },
      providersListResponseSchemaV60.parse({
        providers: [
          {
            ...providerState("copilot"),
            loginCapability: { oauthArgs: ["login"], token: null },
          },
        ],
      }),
    );
    const capability = upgraded.providers[0].loginCapability;
    expect(capability).not.toBeNull();
    // Own key, not merely `undefined` - a missing key and an explicit null
    // are what the GUI gate has to tell apart.
    expect(Object.keys(capability ?? {})).toContain("terminalLogin");
    expect(capability?.terminalLogin).toBeNull();
  });

  it("leaves a null capability null rather than inventing an object", () => {
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["providers.list"],
      { major: 6, minor: 0 },
      { major: 7, minor: 0 },
      providersListResponseSchemaV60.parse({
        providers: [{ ...providerState("cursor"), loginCapability: null }],
      }),
    );
    expect(upgraded.providers[0].loginCapability).toBeNull();
  });
});

describe("providers.startTerminalLogin is an additive optional method", () => {
  it("is registered, declares unsupported degradation, and stays out of the released floor", () => {
    // A new method NAME is handshake-fatal against a released peer, so it has
    // to ride the optional-capability channel exactly like
    // `providers.submitLoginCode` / `touchLogin` do.
    const entry = hostRpcRegistry["providers.startTerminalLogin"];
    expect(entry).toBeDefined();
    expect(entry.degrade).toEqual({ kind: "unsupported" });
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(
      "providers.startTerminalLogin",
    );
  });

  it("requires an epic-scoped request and answers with the session it created", () => {
    expect(
      providersStartTerminalLoginRequestSchema.safeParse({
        providerId: "copilot",
        epicId: "epic-1",
        cols: 120,
        rows: 40,
      }).success,
    ).toBe(true);
    // No epic means no terminal surface to render the session in.
    expect(
      providersStartTerminalLoginRequestSchema.safeParse({
        providerId: "copilot",
        epicId: "",
        cols: 120,
        rows: 40,
      }).success,
    ).toBe(false);
    const response = providersStartTerminalLoginResponseSchema.parse({
      sessionId: "sess-2",
      replacedSessionId: "sess-1",
    });
    expect(response.replacedSessionId).toBe("sess-1");
    expect(
      providersStartTerminalLoginResponseSchema.parse({
        sessionId: "sess-1",
        replacedSessionId: null,
      }).replacedSessionId,
    ).toBeNull();
  });
});
