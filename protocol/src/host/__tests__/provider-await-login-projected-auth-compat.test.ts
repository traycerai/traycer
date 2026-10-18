import { describe, expect, it } from "vitest";
import {
  downgradeResponseAcrossMajors,
  upgradeResponseToVersion,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  providersAwaitLoginResponseSchema,
  providersAwaitLoginResponseSchemaV21,
} from "@traycer/protocol/host/provider-schemas";
import { providersAwaitLoginDowngradeV21ToV20 } from "@traycer/protocol/host/registry";

/**
 * Mirrors the host's projected Kimi completion response (traycer-internal
 * #6345), `traycerai/traycer#2363`.
 *
 * Kimi's credential-file probe can only read `configured`. After a successful
 * `kimi login` the host lifts it to `authenticated` on the
 * `providers.awaitLogin` RESPONSE alone: the projection is
 * `{ ...rawAuth, status: "authenticated" }`, so the badge, label and detail
 * stay as the probe read them and no identity is invented. Kimi has no managed
 * profiles, so `profiles` is `[]`. `providers.list` keeps the raw
 * `configured`. No protocol schema or version changed, which is what this file
 * holds: every released line carries the lifted status through unchanged.
 *
 * Both bodies are captured from the host's own resolver test ("answers the
 * ambient target as authenticated while the catalog keeps reading
 * configured"), with the machine-specific binary path made neutral. They are
 * static on purpose: they are the wire bodies as a host sends them.
 */
const BADGE = "Kimi account";

const KIMI_STATE_BODY = {
  providerId: "kimi",
  enabled: false,
  disabledBy: null,
  selected: { kind: "bundled" },
  candidates: [
    {
      kind: "bundled",
      path: "/usr/local/bin/kimi",
      version: "2.1.1",
      available: true,
      versionPending: false,
    },
  ],
  authPending: false,
  checkedAt: 1792175804591,
  apiKey: { supported: false, configured: false, source: null },
  terminalAgentArgs: "",
  autoJudge: "traycer",
  envOverrides: [],
  loginCapability: null,
  availabilityPending: false,
  nativeCapabilities: {
    supportedTabs: ["general", "env"],
    mcp: null,
    plugins: null,
    skills: null,
    modelProviders: null,
  },
  cliBinaryResolved: true,
  profiles: [],
  managedInstallState: null,
  packId: null,
  managedVersions: null,
  managedVersionsUnavailable: null,
  nextRunBinary: {
    kind: "bundled",
    path: "/usr/local/bin/kimi",
    version: "2.1.1",
  },
  versionVisibility: null,
  advisory: null,
};

const PROJECTED_AUTH = {
  status: "authenticated",
  badgeText: BADGE,
  label: null,
  detail: null,
};

const RAW_AUTH = { ...PROJECTED_AUTH, status: "configured" };

const AWAIT_LOGIN_BODY = {
  state: { ...KIMI_STATE_BODY, auth: PROJECTED_AUTH },
  existingProfileId: null,
  codeRejected: false,
  refusal: null,
};

const LIST_BODY = {
  providers: [{ ...KIMI_STATE_BODY, auth: RAW_AUTH }],
  native: null,
};

const awaitLogin = hostRpcRegistry["providers.awaitLogin"];
const providersList = hostRpcRegistry["providers.list"];

describe("providers.awaitLogin: a projected Kimi completion on every released line", () => {
  it("keeps `authenticated` and the unchanged badge, label and detail on 2.0", () => {
    const parsed =
      awaitLogin[2].versions[0].contract.responseSchema.parse(AWAIT_LOGIN_BODY);
    expect(parsed.state?.providerId).toBe("kimi");
    expect(parsed.state?.auth).toEqual(PROJECTED_AUTH);
  });

  it("keeps `authenticated` and the unchanged badge, label and detail on 2.1", () => {
    const parsed =
      awaitLogin[2].versions[1].contract.responseSchema.parse(AWAIT_LOGIN_BODY);
    expect(parsed.state?.providerId).toBe("kimi");
    expect(parsed.state?.auth).toEqual(PROJECTED_AUTH);
    expect(parsed.state?.profiles).toEqual([]);
    expect(parsed.existingProfileId).toBeNull();
  });

  it("keeps `authenticated` and the unchanged badge, label and detail on 2.2, the head", () => {
    const parsed =
      awaitLogin[2].versions[2].contract.responseSchema.parse(AWAIT_LOGIN_BODY);
    expect(parsed.state?.providerId).toBe("kimi");
    expect(parsed.state?.auth).toEqual(PROJECTED_AUTH);
    expect(parsed.state?.profiles).toEqual([]);
    expect(parsed).toMatchObject({
      existingProfileId: null,
      codeRejected: false,
      refusal: null,
    });
    // The head and the named live schema are the same parse.
    expect(providersAwaitLoginResponseSchema.parse(AWAIT_LOGIN_BODY)).toEqual(
      parsed,
    );
  });

  it("changes only the status of the raw reading: the projection is { ...rawAuth, status }", () => {
    const projected =
      providersAwaitLoginResponseSchema.parse(AWAIT_LOGIN_BODY).state?.auth;
    const raw = providersAwaitLoginResponseSchema.parse({
      ...AWAIT_LOGIN_BODY,
      state: { ...KIMI_STATE_BODY, auth: RAW_AUTH },
    }).state?.auth;
    expect(raw?.status).toBe("configured");
    expect(projected).toEqual({ ...raw, status: "authenticated" });
  });

  it("downgrades 2.1 to 2.0 with the lifted status and the same badge, label and detail", () => {
    const v21 = providersAwaitLoginResponseSchemaV21.parse(AWAIT_LOGIN_BODY);
    const downgraded =
      providersAwaitLoginDowngradeV21ToV20.downgradeResponse(v21);
    if (!downgraded.ok) throw new Error("expected the 2.1 -> 2.0 downgrade");
    expect(downgraded.value.state?.providerId).toBe("kimi");
    expect(downgraded.value.state?.auth).toEqual(PROJECTED_AUTH);
  });

  it("upgrades a 2.0 response to 2.2 without touching the lifted status", () => {
    const v20 =
      awaitLogin[2].versions[0].contract.responseSchema.parse(AWAIT_LOGIN_BODY);
    const upgraded = upgradeResponseToVersion(
      awaitLogin,
      { major: 2, minor: 0 },
      { major: 2, minor: 2 },
      v20,
    );
    expect(upgraded.state?.auth).toEqual(PROJECTED_AUTH);
    expect(upgraded.state?.profiles).toEqual([]);
    expect(upgraded.refusal).toBeNull();
  });

  it("never reaches a 1.0 peer: Kimi is outside that line, so there is no state to misread", () => {
    expect(
      awaitLogin[1].versions[0].contract.responseSchema.safeParse(
        AWAIT_LOGIN_BODY,
      ).success,
    ).toBe(false);
    const head = providersAwaitLoginResponseSchema.parse(AWAIT_LOGIN_BODY);
    const downgraded = downgradeResponseAcrossMajors(awaitLogin, 2, 1, head);
    expect(downgraded.ok).toBe(false);
  });
});

describe("providers.list: the Kimi row keeps the raw `configured` on every released line", () => {
  const lines = [
    {
      version: "2.0",
      schema: providersList[2].versions[0].contract.responseSchema,
    },
    {
      version: "3.0",
      schema: providersList[3].versions[0].contract.responseSchema,
    },
    {
      version: "4.0",
      schema: providersList[4].versions[0].contract.responseSchema,
    },
    {
      version: "5.0",
      schema: providersList[5].versions[0].contract.responseSchema,
    },
    {
      version: "6.0",
      schema: providersList[6].versions[0].contract.responseSchema,
    },
    {
      version: "7.0",
      schema: providersList[7].versions[0].contract.responseSchema,
    },
    {
      version: "8.0",
      schema: providersList[8].versions[0].contract.responseSchema,
    },
    {
      version: "9.0",
      schema: providersList[9].versions[0].contract.responseSchema,
    },
    {
      version: "9.1",
      schema: providersList[9].versions[1].contract.responseSchema,
    },
    {
      version: "9.2",
      schema: providersList[9].versions[2].contract.responseSchema,
    },
    {
      version: "10.0",
      schema: providersList[10].versions[0].contract.responseSchema,
    },
    {
      version: "10.1",
      schema: providersList[10].versions[1].contract.responseSchema,
    },
    {
      version: "10.2",
      schema: providersList[10].versions[2].contract.responseSchema,
    },
  ];

  for (const { version, schema } of lines) {
    it(`reads the Kimi row as configured, badge unchanged, on ${version}`, () => {
      const parsed = schema.parse(LIST_BODY);
      const row = parsed.providers.find(
        (candidate) => candidate.providerId === "kimi",
      );
      expect(row?.auth).toEqual(RAW_AUTH);
    });
  }

  it("never lists Kimi to a 1.0 peer", () => {
    expect(
      providersList[1].versions[0].contract.responseSchema.safeParse(LIST_BODY)
        .success,
    ).toBe(false);
  });
});
