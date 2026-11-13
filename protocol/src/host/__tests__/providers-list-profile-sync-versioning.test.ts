import { describe, expect, it } from "vitest";
import {
  SERVES_EVERY_INSTALLED_MAJOR,
  splitConnectionManifest,
  validateVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import {
  downgradeResponseAcrossMajors,
  upgradeResponseToVersion,
} from "@traycer/protocol/framework/versioned-rpc";
import { buildProtocolSurface } from "@traycer/protocol/framework/surface-build";
import { checkSurfaceCompatibility } from "@traycer/protocol/framework/surface-compat";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { providerProfileSchema } from "@traycer/protocol/host/provider-schemas";
import { resolveUnavailableMethodDegrade } from "@traycer/protocol/host-transport/remote/unavailable-method-degrade";

/**
 * `providers.list@10.11` publishes four profile keys and `removedProfiles`.
 * A 10.9 or 10.10 peer parses that minor's contract, and every older major
 * takes the registry downgrade, so none of the five keys survive. A 10.11
 * client upgrades an older host's answer to the documented defaults.
 * `providers.answerProfileName@1.0` stays off the released floor.
 */
const METHOD = "providers.answerProfileName";
const listLine = hostRpcRegistry["providers.list"][10];
const peer1010 = listLine.versions[10].contract.responseSchema;
const headResponse = listLine.versions[11].contract.responseSchema;
const answerLine = hostRpcRegistry[METHOD];
const answerRequest = answerLine[1].versions[0].contract.requestSchema;
const answerResponse = answerLine[1].versions[0].contract.responseSchema;

const PROFILE_SYNC_KEYS = [
  "aliases",
  "personNotice",
  "terminalOnThisComputer",
  "otherNames",
  "removedProfiles",
] as const;

const ROW_KEYS = [
  "aliases",
  "personNotice",
  "terminalOnThisComputer",
  "otherNames",
] as const;

const profileAuth = {
  status: "authenticated" as const,
  badgeText: null,
  label: null,
  detail: null,
};

const profileFields = {
  authType: "oauth" as const,
  auth: profileAuth,
  identity: null,
  usageUpdatedAt: null,
  rateLimitStatus: "ok" as const,
  rateLimitLimitedScopes: null,
  duplicateOfProfileId: null,
  accentColor: null,
  ambientDriftNotice: null,
  enabled: true,
};

const ambient = {
  ...profileFields,
  profileId: "ambient",
  kind: "ambient" as const,
  label: "Terminal account",
};

const managed = {
  ...profileFields,
  profileId: "managed-1",
  kind: "managed" as const,
  label: "Work",
};

function providerRow<Profile extends object>(profiles: readonly Profile[]) {
  return {
    providerId: "claude-code" as const,
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
    profiles,
  };
}

function listResponse<Profile extends object>(profiles: readonly Profile[]) {
  return { providers: [providerRow(profiles)], native: null };
}

function keysAtAnyDepth(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysAtAnyDepth);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [
    key,
    ...keysAtAnyDepth(child),
  ]);
}

function stringValuesAtKey(value: unknown, keyName: string): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => stringValuesAtKey(entry, keyName));
  }
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const found = key === keyName && typeof child === "string" ? [child] : [];
    return [...found, ...stringValuesAtKey(child, keyName)];
  });
}

type ProvidersListDowngradeMajor =
  keyof (typeof listLine)["downgradePathsFromLatest"];

function isProvidersListDowngradeMajor(
  major: number,
): major is ProvidersListDowngradeMajor {
  return Object.prototype.hasOwnProperty.call(
    listLine.downgradePathsFromLatest,
    major,
  );
}

function providersListDowngradeMajors(): ProvidersListDowngradeMajor[] {
  const majors: ProvidersListDowngradeMajor[] = [];
  for (const key of Object.keys(listLine.downgradePathsFromLatest)) {
    const major = Number(key);
    if (!isProvidersListDowngradeMajor(major)) continue;
    majors.push(major);
  }
  return majors;
}

function expectUpgradeDefaults(upgraded: unknown): void {
  const parsed = headResponse.parse(upgraded);
  expect(parsed.removedProfiles).toEqual([]);
  expect(parsed.providers[0]?.profiles).toEqual([
    expect.objectContaining({
      profileId: "ambient",
      kind: "ambient",
      aliases: [],
      personNotice: null,
      terminalOnThisComputer: true,
      otherNames: [],
    }),
    expect.objectContaining({
      profileId: "managed-1",
      kind: "managed",
      aliases: [],
      personNotice: null,
      terminalOnThisComputer: false,
      otherNames: [],
    }),
  ]);
}

const olderHost = listResponse([ambient, managed]);

const host1011Answer = {
  ...listResponse([
    {
      ...ambient,
      aliases: ["former-ambient"],
      personNotice: "waiting" as const,
      terminalOnThisComputer: false,
      otherNames: ["Personal"],
    },
    {
      ...managed,
      aliases: ["former-managed"],
      personNotice: "needs-sign-in" as const,
      terminalOnThisComputer: true,
      otherNames: ["Former"],
    },
  ]),
  removedProfiles: [
    {
      providerId: "claude-code",
      profileId: "removed-1",
      aliases: ["removed-alias"],
    },
  ],
};

describe("providers.list@10.11 projected to an older minor", () => {
  it("keeps the four row keys and removedProfiles on the 10.11 line", () => {
    const live = headResponse.parse(host1011Answer);
    expect(live.removedProfiles).toEqual(host1011Answer.removedProfiles);
    expect(live.providers[0]?.profiles[0]).toMatchObject({
      aliases: ["former-ambient"],
      personNotice: "waiting",
      terminalOnThisComputer: false,
      otherNames: ["Personal"],
    });
    expect(live.providers[0]?.profiles[1]).toMatchObject({
      terminalOnThisComputer: true,
      personNotice: "needs-sign-in",
      otherNames: ["Former"],
    });
  });

  it.each([9, 10] as const)(
    "gives a 10.%s peer neither the row keys nor removedProfiles",
    (minor) => {
      const received =
        listLine.versions[minor].contract.responseSchema.parse(host1011Answer);
      for (const key of PROFILE_SYNC_KEYS) {
        expect(keysAtAnyDepth(received), key).not.toContain(key);
      }
      expect(received.providers[0]?.profiles).toEqual([
        expect.objectContaining({
          profileId: "ambient",
          kind: "ambient",
          label: "Terminal account",
        }),
        expect.objectContaining({
          profileId: "managed-1",
          kind: "managed",
          label: "Work",
        }),
      ]);
    },
  );
});

describe("providers.list downgrade from major 10", () => {
  it("strips the four row keys and removedProfiles for every older major", () => {
    const canonical = headResponse.parse(host1011Answer);
    const toMajors = providersListDowngradeMajors();
    expect(toMajors).toHaveLength(
      Object.keys(listLine.downgradePathsFromLatest).length,
    );
    expect(toMajors.length).toBeGreaterThanOrEqual(9);

    const majorsMissingProfiles: number[] = [];
    const majorsMissingProvider: number[] = [];
    for (const toMajor of toMajors) {
      const result = downgradeResponseAcrossMajors(
        hostRpcRegistry["providers.list"],
        10,
        toMajor,
        canonical,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      for (const key of PROFILE_SYNC_KEYS) {
        expect(keysAtAnyDepth(result.value), `${toMajor} ${key}`).not.toContain(
          key,
        );
      }
      const profileIds = stringValuesAtKey(result.value, "profileId");
      if (
        !profileIds.includes("ambient") ||
        !profileIds.includes("managed-1")
      ) {
        majorsMissingProfiles.push(toMajor);
      }
      if (
        !stringValuesAtKey(result.value, "providerId").includes("claude-code")
      ) {
        majorsMissingProvider.push(toMajor);
      }
    }
    expect(majorsMissingProvider).toEqual([]);
    // 1, 2 and 3 predate profile rows. Every later major keeps both.
    expect(majorsMissingProfiles).toEqual([1, 2, 3]);
  });
});

describe("providers.list upgrade to 10.11", () => {
  it("fills the defaults when a 10.11 client reads a 10.10 host", () => {
    const parsed = peer1010.parse(olderHost);
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["providers.list"],
      { major: 10, minor: 10 },
      { major: 10, minor: 11 },
      parsed,
    );
    expectUpgradeDefaults(upgraded);
  });

  it("ends on the same defaults when the host is on 10.8", () => {
    const parsed =
      listLine.versions[8].contract.responseSchema.parse(olderHost);
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["providers.list"],
      { major: 10, minor: 8 },
      { major: 10, minor: 11 },
      parsed,
    );
    expectUpgradeDefaults(upgraded);
  });
});

describe("providers.list@10.11 field fallback", () => {
  it("drops an unknown personNotice or a malformed otherNames and keeps the row", () => {
    const parsed = headResponse.parse(
      listResponse([
        {
          ...ambient,
          aliases: ["former-ambient"],
          personNotice: "removed",
          terminalOnThisComputer: false,
          otherNames: ["Personal"],
        },
        {
          ...managed,
          aliases: ["former-managed"],
          personNotice: "needs-sign-in",
          terminalOnThisComputer: true,
          otherNames: [""],
        },
      ]),
    );
    const profiles = parsed.providers[0]?.profiles;
    expect(profiles).toHaveLength(2);
    expect(profiles?.[0]).toMatchObject({
      profileId: "ambient",
      kind: "ambient",
      enabled: true,
      aliases: ["former-ambient"],
      terminalOnThisComputer: false,
      otherNames: ["Personal"],
    });
    expect(profiles?.[0]?.personNotice).toBeUndefined();
    expect(profiles?.[0]?.readability?.kind).not.toBe("unreadable");
    expect(profiles?.[1]).toMatchObject({
      profileId: "managed-1",
      kind: "managed",
      enabled: true,
      personNotice: "needs-sign-in",
      terminalOnThisComputer: true,
      rateLimitStatus: "ok",
    });
    expect(profiles?.[1]?.otherNames).toBeUndefined();
    expect(profiles?.[1]?.readability?.kind).not.toBe("unreadable");
  });
});

describe("providerProfileSchema mutation echo", () => {
  const echoedProfile = {
    ...managed,
    aliases: ["former-managed"],
    personNotice: "waiting" as const,
    terminalOnThisComputer: true,
    otherNames: ["Personal"],
  };

  it("strips the four keys from the shared profile schema", () => {
    const parsed = providerProfileSchema.parse(echoedProfile);
    for (const key of ROW_KEYS) {
      expect(parsed).not.toHaveProperty(key);
    }
    expect(parsed).toMatchObject({
      profileId: "managed-1",
      kind: "managed",
      label: "Work",
      enabled: true,
    });
  });

  it("strips the four keys from a providers.setEnabled echo", () => {
    const echo =
      hostRpcRegistry["providers.setEnabled"][2].versions[1].contract
        .responseSchema;
    const parsed = echo.parse({
      state: providerRow([echoedProfile]),
    });
    const profile = parsed.state.profiles[0];
    expect(profile).toMatchObject({
      profileId: "managed-1",
      label: "Work",
    });
    for (const key of ROW_KEYS) {
      expect(profile).not.toHaveProperty(key);
    }
  });
});

describe("providers.answerProfileName", () => {
  const validRequest = {
    providerId: "claude-code" as const,
    profileId: "managed-1",
    label: "n".repeat(64),
  };

  it("is registered at 1.0 off the released floor", () => {
    expect(() =>
      validateVersionedRpcRegistry({
        [METHOD]: hostRpcRegistry[METHOD],
      }),
    ).not.toThrow();
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(METHOD);
    expect(answerLine.degrade).toEqual({ kind: "unsupported" });
    expect(answerLine[1].latestMinor).toBe(0);

    const split = splitConnectionManifest(
      hostRpcRegistry,
      RELEASED_FLOOR_METHOD_NAMES,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
    expect(split.optionalManifest[METHOD]).toEqual({ major: 1, minor: 0 });
    expect(split.manifest[METHOD]).toBeUndefined();
  });

  it("is an advisory finding against a peer that does not advertise it", () => {
    const mine = buildProtocolSurface({
      unary: { [METHOD]: hostRpcRegistry[METHOD] },
      unaryFloorMethodNames: RELEASED_FLOOR_METHOD_NAMES,
      stream: {},
    });
    const theirs = buildProtocolSurface({
      unary: {},
      unaryFloorMethodNames: RELEASED_FLOOR_METHOD_NAMES,
      stream: {},
    });
    const result = checkSurfaceCompatibility({
      mine,
      theirs,
      theirsLabel: "released",
      exceptions: [],
    });
    expect(result.blocking).toEqual([]);
    expect(result.findings).toEqual([
      expect.objectContaining({
        method: METHOD,
        family: "unary",
        severity: "advisory",
      }),
    ]);
    expect(result.findings[0]?.detail).toContain("unsupported");
  });

  it("answers unsupported when the peer does not advertise the method", async () => {
    await expect(
      resolveUnavailableMethodDegrade({
        registry: hostRpcRegistry,
        method: METHOD,
        methodRegistry: answerLine,
        clientCanonical: { major: 1, minor: 0 },
        clientManifest: { [METHOD]: { major: 1, minor: 0 } },
        hostManifest: {},
        params: validRequest,
        requestId: "req-answer-name",
        execute: () => Promise.reject(new Error("fallback must not run")),
      }),
    ).rejects.toMatchObject({
      code: "E_HOST_UNSUPPORTED",
      method: METHOD,
      fatalDetails: {
        code: "E_HOST_UNSUPPORTED",
        upgradeGuidance: {
          clientShouldUpgrade: false,
          hostShouldUpgrade: true,
        },
      },
    });
  });

  it("parses a 64-character label and rejects an empty or 65-character one", () => {
    expect(answerRequest.parse(validRequest)).toEqual(validRequest);
    expect(
      answerRequest.safeParse({ ...validRequest, label: "" }).success,
    ).toBe(false);
    expect(
      answerRequest.safeParse({ ...validRequest, label: "n".repeat(65) })
        .success,
    ).toBe(false);
  });

  it("parses a label and rejects a response without one", () => {
    expect(answerResponse.parse({ label: "Ada" })).toEqual({ label: "Ada" });
    expect(answerResponse.safeParse({}).success).toBe(false);
  });
});
