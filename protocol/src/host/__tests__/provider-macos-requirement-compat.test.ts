import { describe, expect, it } from "vitest";
import {
  downgradeResponseAcrossMajors,
  upgradeResponseToVersion,
} from "@traycer/protocol/framework/versioned-rpc";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import * as providerSchemas from "@traycer/protocol/host/provider-schemas";
import {
  providerCliStateSchema,
  providerMutationCliStateSchemaV21,
  providersListResponseSchema,
  providersListResponseSchemaV102Preimage,
  providersUsePackVersionResponseSchema,
} from "@traycer/protocol/host/provider-schemas";

/**
 * `macosRequirement` rides `providers.list@10.2` and the typed
 * `macos-ineligible` refusal rides `providers.usePackVersion@1.1`. Both
 * minors are new lines, so every released line derived from the live state
 * must keep refusing the new key's shape.
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
    profiles: [],
  };
}

const REQUIREMENT = {
  runningMacos: "13.6",
  managed: { requiredMacos: "14.0" },
  launch: { requiredMacos: "14.0" },
  refusedVersions: [
    { version: "2.0.0", requiredMacos: "15.0" },
    { version: "3.0.0", requiredMacos: "16.0" },
  ],
};

const MACOS_INELIGIBLE = {
  ok: false,
  code: "macos-ineligible",
  requiredMacos: "15.0",
  runningMacos: "14.2",
} as const;

describe("providers.list@10.2 carries macosRequirement", () => {
  it("keeps the 10.2 macOS capability line registered", () => {
    const entry = hostRpcRegistry["providers.list"][10];
    expect(entry.latestMinor).toBe(3);
    expect(entry.versions[2].contract.schemaVersion).toEqual({
      major: 10,
      minor: 2,
    });
    // A new KEY, not value growth: no growth gate on the list minor.
    expect(entry.versions[2]).not.toHaveProperty(
      "responseGrowthProjectionGated",
    );
  });

  it("parses the live state with the field, without it, and degrades a malformed value to null", () => {
    const withField = providerCliStateSchema.parse({
      ...providerState("antigravity"),
      macosRequirement: REQUIREMENT,
    });
    expect(withField.macosRequirement).toEqual(REQUIREMENT);

    const without = providerCliStateSchema.parse(providerState("antigravity"));
    // Absent from an older host: never read as a block. The key is either
    // absent or null, and is never a populated object.
    expect(
      without.macosRequirement === undefined ||
        without.macosRequirement === null,
    ).toBe(true);

    const explicitNull = providerCliStateSchema.parse({
      ...providerState("antigravity"),
      macosRequirement: null,
    });
    expect(explicitNull.macosRequirement).toBeNull();

    const malformed = providerCliStateSchema.parse({
      ...providerState("antigravity"),
      macosRequirement: { runningMacos: 13, managed: "14.0" },
    });
    // A malformed value must not take the row down with it.
    expect(malformed.providerId).toBe("antigravity");
    expect(malformed.macosRequirement).toBeNull();

    const badVersions = providerCliStateSchema.parse({
      ...providerState("antigravity"),
      macosRequirement: { ...REQUIREMENT, refusedVersions: "2.0.0" },
    });
    // Only the list degrades, to []; the rest of the requirement survives.
    expect(badVersions.macosRequirement).toEqual({
      ...REQUIREMENT,
      refusedVersions: [],
    });
  });

  it("keeps the released 10.1, 10.0, 9.2 and 9.1 lines from modelling the new key", () => {
    const row = {
      ...providerState("antigravity"),
      macosRequirement: REQUIREMENT,
    };
    const head = providersListResponseSchema.parse({
      providers: [row],
      native: null,
    });
    expect(head.providers[0]).toHaveProperty("macosRequirement");

    for (const [major, minor] of [
      [10, 1],
      [10, 0],
      [9, 2],
      [9, 1],
    ] as const) {
      const parsed = hostRpcRegistry["providers.list"][major].versions[
        minor
      ].contract.responseSchema.parse({ providers: [row], native: null });
      expect(parsed.providers[0], `${major}.${minor}`).not.toHaveProperty(
        "macosRequirement",
      );
    }
  });

  it("keeps the frozen mutation echo from ever carrying macosRequirement", () => {
    const echo = providerMutationCliStateSchemaV21.parse({
      ...providerState("antigravity"),
      macosRequirement: REQUIREMENT,
    });
    expect(echo).not.toHaveProperty("macosRequirement");
  });

  it("binds 10.1 to its own preimage instead of the live response", () => {
    const preimage = Reflect.get(
      providerSchemas,
      "providersListResponseSchemaV101Preimage",
    );
    expect(preimage).toBeDefined();
    expect(
      hostRpcRegistry["providers.list"][10].versions[1].contract,
    ).toMatchObject({ responseSchema: preimage });
    expect(
      hostRpcRegistry["providers.list"][10].versions[2].contract,
    ).toMatchObject({
      responseSchema: providersListResponseSchemaV102Preimage,
    });
  });

  it("upgrades a 10.1 response by filling macosRequirement: null on every provider", () => {
    const response = hostRpcRegistry[
      "providers.list"
    ][10].versions[1].contract.responseSchema.parse({
      providers: [providerState("antigravity"), providerState("codex")],
      native: null,
    });
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["providers.list"],
      { major: 10, minor: 1 },
      { major: 10, minor: 2 },
      response,
    );
    expect(upgraded.providers).toHaveLength(2);
    for (const provider of upgraded.providers) {
      // Chained upgrades are applied by cast with no re-parse, so the key has
      // to be present as null rather than merely absent.
      expect(provider).toHaveProperty("macosRequirement", null);
    }
  });

  it("strips the field when the head response is downgraded across majors", () => {
    const response = providersListResponseSchema.parse({
      providers: [
        { ...providerState("antigravity"), macosRequirement: REQUIREMENT },
      ],
      native: null,
    });
    const downgraded = downgradeResponseAcrossMajors(
      hostRpcRegistry["providers.list"],
      10,
      9,
      response,
    );
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    expect(downgraded.value.providers[0]).not.toHaveProperty(
      "macosRequirement",
    );
  });
});

describe("providers.usePackVersion@1.1 carries the macos-ineligible arm", () => {
  it("opens minor 1 with the value-growth gate declared on it alone", () => {
    const entry = hostRpcRegistry["providers.usePackVersion"][1];
    expect(entry.latestMinor).toBe(1);
    expect(entry.versions[1].contract.schemaVersion).toEqual({
      major: 1,
      minor: 1,
    });
    expect(entry.versions[1]).toHaveProperty(
      "responseGrowthProjectionGated",
      true,
    );
    expect(entry.versions[0]).not.toHaveProperty(
      "responseGrowthProjectionGated",
    );
  });

  it("accepts the arm on the live response and refuses it on the frozen 1.0 response", () => {
    expect(
      providersUsePackVersionResponseSchema.parse({ result: MACOS_INELIGIBLE })
        .result,
    ).toEqual(MACOS_INELIGIBLE);
    const v10 =
      hostRpcRegistry["providers.usePackVersion"][1].versions[0].contract
        .responseSchema;
    expect(v10.safeParse({ result: MACOS_INELIGIBLE }).success).toBe(false);
    // The three released codes are untouched.
    expect(
      v10.safeParse({
        result: { ok: false, code: "host-ineligible", detail: null },
      }).success,
    ).toBe(true);
  });

  it("bounds both versions to the major.minor[.patch] digit form", () => {
    for (const bad of [
      "",
      "14",
      "14.x",
      "fourteen.0",
      "14.0.0.0",
      "14.0 ",
      "<b>14.0</b>",
      "1".repeat(20) + "." + "2".repeat(20),
    ]) {
      expect(
        providersUsePackVersionResponseSchema.safeParse({
          result: { ...MACOS_INELIGIBLE, requiredMacos: bad },
        }).success,
        `requiredMacos ${JSON.stringify(bad)}`,
      ).toBe(false);
      expect(
        providersUsePackVersionResponseSchema.safeParse({
          result: { ...MACOS_INELIGIBLE, runningMacos: bad },
        }).success,
        `runningMacos ${JSON.stringify(bad)}`,
      ).toBe(false);
    }
    for (const good of ["14.0", "13.6.1"]) {
      expect(
        providersUsePackVersionResponseSchema.safeParse({
          result: { ...MACOS_INELIGIBLE, requiredMacos: good },
        }).success,
      ).toBe(true);
    }
  });

  it("projects the arm to verification-failed for a 1.0 caller and passes everything else through", () => {
    const projector: unknown = Reflect.get(
      providerSchemas,
      "projectUsePackVersionResultToV10",
    );
    if (typeof projector !== "function") {
      throw new Error("projectUsePackVersionResultToV10 is not exported");
    }
    const project = (result: unknown): unknown =>
      Reflect.apply(projector, undefined, [result]);

    const projected = project(MACOS_INELIGIBLE);
    expect(projected).toEqual({
      ok: false,
      code: "verification-failed",
      detail: null,
    });
    const v10 =
      hostRpcRegistry["providers.usePackVersion"][1].versions[0].contract
        .responseSchema;
    expect(v10.safeParse({ result: projected }).success).toBe(true);

    for (const unchanged of [
      { ok: true, pinnedVersion: "1.2.3" },
      { ok: true, pinnedVersion: null },
      { ok: false, code: "below-security-floor", detail: "floor" },
      { ok: false, code: "host-ineligible", detail: null },
      { ok: false, code: "verification-failed", detail: "x" },
    ]) {
      expect(project(unchanged)).toEqual(unchanged);
    }
  });
});
