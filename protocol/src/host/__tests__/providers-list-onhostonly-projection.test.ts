import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";

/**
 * `providers.list@10.3` added `onHostOnly` (and `scope`) to the ENVELOPE, and
 * a 10.0 peer must receive a response with neither, on every row it carries.
 *
 * The key sits on the envelope rather than on the profile row because the
 * profile row (`providerProfileSchema`) is shared BY REFERENCE by the 10.0 and
 * 10.3 provider rows: a profile-level key would widen the released 10.0 line
 * too, and the within-major re-parse would no longer strip it. The existing
 * projection test in `environment-wire.test.ts` runs on an empty `providers`
 * array, so it cannot see that class of regression; this one carries a provider
 * row WITH profiles.
 *
 * `project100` and `parse101` are the only two lines that name the schemas
 * under test, so a negative control can swap them for a mutated copy.
 */
const providersListLine = hostRpcRegistry["providers.list"][10];
const project100 = (response: unknown) =>
  providersListLine.versions[0].contract.responseSchema.parse(response);
const parse103 = (response: unknown) =>
  providersListLine.versions[3].contract.responseSchema.parse(response);

const profileBase = {
  enabled: true,
  authType: "oauth",
  auth: { status: "authenticated", badgeText: null, label: null, detail: null },
  identity: null,
  usageUpdatedAt: null,
  rateLimitStatus: "ok",
  rateLimitLimitedScopes: null,
  duplicateOfProfileId: null,
  accentColor: null,
  ambientDriftNotice: null,
};

/**
 * A realistic 10.3 response: one provider with an ambient and a managed
 * profile, the envelope's `scope` and `onHostOnly`, and (the regression
 * guard) an `onHostOnly` key on the managed profile ROW, which is where the
 * schema comments rule the key out. Both places must not survive a 10.0
 * projection.
 */
function tenOneResponse() {
  return {
    providers: [
      {
        providerId: "claude-code",
        enabled: true,
        disabledBy: null,
        selected: { kind: "bundled" },
        candidates: [],
        auth: {
          status: "unknown",
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
        profiles: [
          {
            ...profileBase,
            profileId: "ambient",
            kind: "ambient",
            label: "Terminal account",
          },
          {
            ...profileBase,
            profileId: "p1",
            kind: "managed",
            label: "Work",
            onHostOnly: true,
          },
        ],
      },
    ],
    native: null,
    scope: "personal",
    onHostOnly: [{ providerId: "claude-code", profileId: "p1" }],
  };
}

/** Every key name anywhere under `value`, to prove a key is gone at any depth. */
function keysAtAnyDepth(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysAtAnyDepth);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [
    key,
    ...keysAtAnyDepth(child),
  ]);
}

/** The provider and its profiles exactly as a 10.0 peer receives them. */
const EXPECTED_TEN_ZERO = {
  providers: [
    {
      providerId: "claude-code",
      enabled: true,
      disabledBy: null,
      selected: { kind: "bundled" },
      candidates: [],
      authPending: false,
      checkedAt: null,
      apiKey: { supported: false, configured: false, source: null },
      terminalAgentArgs: "",
      envOverrides: [],
      loginCapability: null,
      availabilityPending: false,
      profiles: [
        {
          profileId: "ambient",
          kind: "ambient",
          authType: "oauth",
          label: "Terminal account",
          auth: {
            status: "authenticated",
            badgeText: null,
            label: null,
            detail: null,
          },
          identity: null,
          usageUpdatedAt: null,
          rateLimitStatus: "ok",
          rateLimitLimitedScopes: null,
          duplicateOfProfileId: null,
          ambientDriftNotice: null,
          accentColor: null,
          enabled: true,
        },
        {
          profileId: "p1",
          kind: "managed",
          authType: "oauth",
          label: "Work",
          auth: {
            status: "authenticated",
            badgeText: null,
            label: null,
            detail: null,
          },
          identity: null,
          usageUpdatedAt: null,
          rateLimitStatus: "ok",
          rateLimitLimitedScopes: null,
          duplicateOfProfileId: null,
          ambientDriftNotice: null,
          accentColor: null,
          enabled: true,
        },
      ],
      auth: {
        status: "unknown",
        badgeText: null,
        label: null,
        detail: null,
      },
      nativeCapabilities: {
        supportedTabs: ["general", "env", "usage"],
        mcp: null,
        plugins: null,
        skills: null,
        modelProviders: null,
      },
    },
  ],
  native: null,
};

describe("providers.list@10.3 projected to 10.0, with a provider row that has profiles", () => {
  it("keeps the envelope's onHostOnly and scope for a 10.3 peer", () => {
    const live = parse103(tenOneResponse());
    expect(live).toHaveProperty("scope", "personal");
    expect(live).toHaveProperty("onHostOnly", [
      { providerId: "claude-code", profileId: "p1" },
    ]);
  });

  it("does not model onHostOnly on the profile row, even for a 10.3 peer", () => {
    const live = parse103(tenOneResponse());
    expect(keysAtAnyDepth(live.providers)).not.toContain("onHostOnly");
  });

  it("projects to exactly the 10.0 shape: profiles intact, onHostOnly and scope nowhere", () => {
    const projected = project100(tenOneResponse());
    expect(projected).toEqual(EXPECTED_TEN_ZERO);
    expect(keysAtAnyDepth(projected)).not.toContain("onHostOnly");
    expect(keysAtAnyDepth(projected)).not.toContain("scope");
  });

  it("projects the same 10.0 shape whether or not the response carried an onHostOnly envelope", () => {
    const withoutEnvelopeKeys = {
      ...tenOneResponse(),
      scope: null,
      onHostOnly: [],
    };
    expect(project100(withoutEnvelopeKeys)).toEqual(EXPECTED_TEN_ZERO);
  });
});
