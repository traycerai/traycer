import { describe, expect, it } from "vitest";
import {
  downgradeResponseAcrossMajors,
  upgradeResponseToVersion,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  providerLoginCapabilitySchema,
  providerLoginCapabilitySchemaV70,
  providerMutationCliStateSchemaV21,
  providersListResponseSchema,
  providersListResponseSchemaV70,
  providersListResponseSchemaV80,
} from "@traycer/protocol/host/provider-schemas";

/**
 * The two major-9 login-capability markers, which ride the same line and the
 * same bridge and are asserted together for that reason:
 *
 *   - `remoteSafe` - the headless `providers.startLogin` flow completes without
 *     a loopback callback on the host, so the GUI may offer it on a REMOTE
 *     host;
 *   - `selfOpensBrowser` - the provider's own child opens a browser, so the
 *     GUI must not open a second one.
 *
 * They are independent (Kimi is the only provider that is both), and the live
 * schema models both while the frozen v7.0 / v8.0 list lines - both released -
 * must model neither.
 *
 * The half that matters is not "the live schema has the key". It is that an OLD
 * host's payload reaches a client with the key `null` rather than ABSENT. A
 * client decodes through the NEGOTIATED FROZEN schema, so the live
 * `.catch(null)` never runs, and only the first bridge whose target models the
 * key can supply it. A suite that exercised the live schema alone would pass
 * while that bug shipped, which is why every assertion below that carries
 * weight starts from a frozen decode.
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

// What a host at or below `providers.list@8.0` actually serializes: the four
// keys v7.0 froze, and no `remoteSafe` at all. Deliberately NOT built by
// omitting a key from a live capability - the premise is a payload that
// predates the field.
const OLD_HOST_CAPABILITY = {
  oauthArgs: ["auth", "login"],
  token: null,
  codePaste: null,
  terminalLogin: null,
};

const REMOTE_SAFE_CAPABILITY = {
  ...OLD_HOST_CAPABILITY,
  remoteSafe: {},
  selfOpensBrowser: {},
};

describe("remoteSafe is a major-9 login capability", () => {
  it("the live capability keeps it", () => {
    const parsed = providerLoginCapabilitySchema.parse(REMOTE_SAFE_CAPABILITY);
    expect(parsed.remoteSafe).toEqual({});
  });

  it("the live capability catches a present-but-unrecognized value to null", () => {
    // `.catch(null)` is the mid-rollout guard: a host sending something else
    // must not break `providers.list` for every provider on the client.
    for (const garbage of ["yes", 1, true] as const) {
      const parsed = providerLoginCapabilitySchema.parse({
        ...OLD_HOST_CAPABILITY,
        remoteSafe: garbage,
      });
      expect(parsed.remoteSafe).toBeNull();
    }
  });

  it("the frozen v7.0 capability strips it", () => {
    // The concrete case the v7.0 pin has been holding open since it was
    // written: "once a real fifth capability field lands live (the way
    // `terminalLogin` did on v7.0 itself), this frozen copy must keep stripping
    // it." `remoteSafe` is that field, and `selfOpensBrowser` is the sixth -
    // the key-set assertion is what makes this fail for the NEXT one too.
    const parsed = providerLoginCapabilitySchemaV70.parse(
      REMOTE_SAFE_CAPABILITY,
    );
    expect(parsed).not.toHaveProperty("remoteSafe");
    expect(parsed).not.toHaveProperty("selfOpensBrowser");
    expect(Object.keys(parsed).sort()).toEqual(
      ["codePaste", "oauthArgs", "terminalLogin", "token"].sort(),
    );
  });

  // Both directions, for the reason the `terminalLogin` suite states: "the
  // frozen shape strips it" is also true of a schema that never models the
  // field anywhere, and "the live shape keeps it" is also true of a frozen
  // shape that leaks.
  it("the frozen v7.0 and v8.0 list lines strip it from a provider row", () => {
    const payload = {
      providers: [
        { ...providerState("kimi"), loginCapability: REMOTE_SAFE_CAPABILITY },
      ],
      native: null,
    };
    const capabilities = [
      providersListResponseSchemaV70.parse(payload).providers[0]
        .loginCapability,
      providersListResponseSchemaV80.parse(payload).providers[0]
        .loginCapability,
    ];
    for (const capability of capabilities) {
      expect(capability).not.toBeNull();
      expect(capability).not.toHaveProperty("remoteSafe");
      expect(capability).not.toHaveProperty("selfOpensBrowser");
      // A field freeze, not a capability blackout - the rest still rides the
      // line.
      expect(capability?.oauthArgs).toEqual(["auth", "login"]);
    }
  });

  it("the @2.1 mutation state echo strips it", () => {
    // Ten released echoes share this shape, and a login cannot change whether
    // a provider's flow needs a loopback callback anyway.
    const parsed = providerMutationCliStateSchemaV21.parse({
      ...providerState("kimi"),
      loginCapability: REMOTE_SAFE_CAPABILITY,
    });
    expect(parsed.loginCapability).not.toHaveProperty("remoteSafe");
    expect(parsed.loginCapability).not.toHaveProperty("selfOpensBrowser");
  });

  it("the live providers.list response keeps it", () => {
    const parsed = providersListResponseSchema.parse({
      providers: [
        { ...providerState("kimi"), loginCapability: REMOTE_SAFE_CAPABILITY },
      ],
      native: null,
    });
    expect(parsed.providers[0].loginCapability?.remoteSafe).toEqual({});
    expect(parsed.providers[0].loginCapability?.selfOpensBrowser).toEqual({});
  });
});

describe("providers.list v8->v9 fills remoteSafe for an old host", () => {
  // The frozen decode a v9 client actually performs against a v8.0 host. Built
  // fresh per assertion, because the absence it carries is the whole premise.
  function decodeOldHostThroughFrozenV80() {
    return providersListResponseSchemaV80.parse({
      providers: [
        { ...providerState("kimi"), loginCapability: OLD_HOST_CAPABILITY },
      ],
      native: null,
    });
  }

  it("the frozen v8.0 decode leaves the key genuinely ABSENT, not null", () => {
    // The control for the test below, and the reason that test is written
    // against a frozen decode at all. The live schema's `.catch(null)` never
    // runs on this path: the client parses with the NEGOTIATED schema, and
    // v8.0 does not model the key, so nothing defaults it. If this ever reads
    // `null`, the two shapes have been collapsed and the bridge assertion below
    // has stopped proving anything.
    const capability =
      decodeOldHostThroughFrozenV80().providers[0].loginCapability;
    expect(capability).not.toBeNull();
    expect(capability).not.toHaveProperty("remoteSafe");
  });

  it("fills null through the REGISTERED bridge, not just a hand-called helper", () => {
    // `providersListUpgradeV80ToV90` is the first bridge whose TARGET models
    // `remoteSafe`, because v7.0 and v8.0 are both pinned to the four-key
    // `providerLoginCapabilitySchemaV70`. Driving the registry rather than the
    // helper is what pins the fill to THAT hop: `upgradeResponseToVersion`
    // chains these callbacks by cast with no re-parse, so a fill placed on a
    // hop whose target does not model the key (the v7->v8 one, say) is silently
    // dropped and this goes red.
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["providers.list"],
      { major: 8, minor: 0 },
      { major: 9, minor: 0 },
      decodeOldHostThroughFrozenV80(),
    );
    const capability = upgraded.providers[0].loginCapability;
    expect(capability).not.toBeNull();
    expect(capability).toHaveProperty("remoteSafe");
    expect(capability).toHaveProperty("selfOpensBrowser");
    // `null`, never `{}`, for both - and they are null for OPPOSITE safety
    // reasons, which is why each is asserted rather than the pair being
    // spot-checked. A `{}` `remoteSafe` would declare every pre-9.0 provider
    // remote-safe and offer sign-ins that cannot complete; a `{}`
    // `selfOpensBrowser` would suppress the GUI's own browser open and strand
    // the user at a waiting step with nothing opened.
    expect(capability?.remoteSafe).toBeNull();
    expect(capability?.selfOpensBrowser).toBeNull();
    // The fill leaves the rest of the capability alone.
    expect(capability?.oauthArgs).toEqual(["auth", "login"]);
    expect(capability?.terminalLogin).toBeNull();
  });

  it("survives the chain all the way to the head line", () => {
    // 9.0 -> 9.1 is identity, so the fill has to still be there at the head a
    // current client negotiates.
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["providers.list"],
      { major: 8, minor: 0 },
      { major: 9, minor: 1 },
      decodeOldHostThroughFrozenV80(),
    );
    const capability = upgraded.providers[0].loginCapability;
    expect(capability?.remoteSafe).toBeNull();
    expect(capability?.selfOpensBrowser).toBeNull();
  });

  it("carries a null loginCapability through unchanged", () => {
    // Cursor's case: no web login at all. The fill must not manufacture a
    // capability object where the host reported none.
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["providers.list"],
      { major: 8, minor: 0 },
      { major: 9, minor: 0 },
      providersListResponseSchemaV80.parse({
        providers: [providerState("cursor")],
        native: null,
      }),
    );
    expect(upgraded.providers[0].loginCapability).toBeNull();
  });
});

describe("remoteSafe never reaches a released providers.list line", () => {
  it("the v9 -> v8 and v9 -> v7 downgrades strip it", () => {
    for (const target of [8, 7] as const) {
      const downgraded = downgradeResponseAcrossMajors(
        hostRpcRegistry["providers.list"],
        9,
        target,
        providersListResponseSchema.parse({
          providers: [
            {
              ...providerState("kimi"),
              loginCapability: REMOTE_SAFE_CAPABILITY,
            },
          ],
          native: null,
        }),
      );
      expect(downgraded.ok).toBe(true);
      if (!downgraded.ok) continue;
      const capability = downgraded.value.providers[0].loginCapability;
      expect(capability).not.toBeNull();
      expect(capability).not.toHaveProperty("remoteSafe");
      expect(capability).not.toHaveProperty("selfOpensBrowser");
    }
  });
});
