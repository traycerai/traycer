import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CLIENT_UPGRADE_CHANNELS,
  CURRENT_CLIENT_COMPATIBILITY_EPOCH,
  LEGACY_CLIENT_COMPATIBILITY_EPOCH,
  MAX_DIAGNOSTIC_APP_VERSION_LENGTH,
  STRICT_SEMVER_PATTERN,
  isStrictSemVer,
  clientCompatibilityRequirementSchema,
  clientHandshakeIdentitySchema,
  isClientUpgradeChannel,
  isValidCompatibilityEpoch,
  toClientHandshakeIdentity,
  type ClientCompatibilityRequirement,
} from "@traycer/protocol/framework/client-identity";
import {
  clientOpenFrameSchema,
  fatalErrorDetailsSchema,
  connectionManifestSchema,
  incompatibilityUpgradeGuidanceSchema,
  incompatibleMethodDetailsSchema,
} from "@traycer/protocol/framework/ws-protocol";
import { clientStreamOpenFrameSchema } from "@traycer/protocol/framework/stream-ws-protocol";
import { sessionOpenPayloadSchema } from "@traycer/protocol/host-transport/mux";

/**
 * The wire half of the client-compatibility epoch handshake.
 *
 * Two properties carry the whole backward story, and both are asserted here
 * against RECONSTRUCTED RELEASED SCHEMAS rather than described in prose:
 *
 *  1. A released OLD peer parsing a NEW frame must STRIP the additive field,
 *     not reject the frame. That is what lets a new client talk to a host that
 *     has never heard of identity.
 *  2. A NEW peer parsing an OLD frame must accept the omission, not fail
 *     validation. That is what lets an old client reach the host's deliberate
 *     legacy-epoch verdict instead of an unactionable "malformed frame".
 *
 * The released schemas below are hand-reconstructed from the shapes that
 * shipped before this change. That is a real limitation - they are a model of
 * the released peer, not the released peer - so they are kept minimal and
 * mirror only the members whose presence/absence this test turns on.
 */

const RELEASED_MANIFEST = { "host.status": { major: 1, minor: 0 } };

/** `clientOpenFrameSchema` as it shipped BEFORE `clientIdentity` existed. */
const releasedClientOpenFrameSchema = z.object({
  kind: z.literal("open"),
  token: z.string(),
  manifest: connectionManifestSchema,
  optionalManifest: connectionManifestSchema.optional(),
});

/** `clientStreamOpenFrameSchema` as it shipped before `clientIdentity`. */
const releasedClientStreamOpenFrameSchema = z.object({
  kind: z.literal("open"),
  token: z.string(),
  manifest: connectionManifestSchema,
});

/** `fatalErrorDetailsSchema` as it shipped before the epoch requirement. */
const releasedFatalErrorDetailsSchema = z.object({
  code: z.string().min(1),
  reason: z.string(),
  incompatibleMethods: z.array(incompatibleMethodDetailsSchema).nullable(),
  upgradeGuidance: incompatibilityUpgradeGuidanceSchema.nullable(),
  retryable: z.boolean().optional(),
});

const REQUIREMENT: ClientCompatibilityRequirement = {
  minimumCompatibilityEpoch: 2,
  observedCompatibilityEpoch: null,
  failure: "missing-epoch",
  observedClientKind: null,
  observedClientAppVersion: null,
  observedClientAppVersionStatus: "missing",
  minimumKnownClientAppVersion: "1.2.0-rc.2",
  upgradeChannel: "rc",
};

describe("client handshake identity", () => {
  it("is cumulative: the current epoch is above the legacy one", () => {
    // Not a tautology check. A change that made the current epoch equal the
    // legacy one would silently make every floor unenforceable, and a change
    // that made it non-integral would make every client `invalid-epoch`.
    expect(isValidCompatibilityEpoch(CURRENT_CLIENT_COMPATIBILITY_EPOCH)).toBe(
      true,
    );
    expect(CURRENT_CLIENT_COMPATIBILITY_EPOCH).toBeGreaterThan(
      LEGACY_CLIENT_COMPATIBILITY_EPOCH,
    );
  });

  it("classifies epoch validity the way admission policy needs", () => {
    expect(isValidCompatibilityEpoch(1)).toBe(true);
    expect(isValidCompatibilityEpoch(0)).toBe(false);
    expect(isValidCompatibilityEpoch(-1)).toBe(false);
    expect(isValidCompatibilityEpoch(2.5)).toBe(false);
    expect(isValidCompatibilityEpoch(Number.MAX_SAFE_INTEGER + 2)).toBe(false);
    expect(isValidCompatibilityEpoch(Number.NaN)).toBe(false);
    expect(isValidCompatibilityEpoch(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("omits only a null appVersion when projecting a first-party identity", () => {
    expect(
      toClientHandshakeIdentity({
        kind: "desktop",
        compatibilityEpoch: 2,
        appVersion: "1.2.0",
      }),
    ).toEqual({ kind: "desktop", compatibilityEpoch: 2, appVersion: "1.2.0" });
    // The KEY is absent, not present-and-undefined: zod's only tolerant shape
    // is `.optional()`, and `JSON.stringify` drops an undefined value anyway -
    // asserting the key set is what pins that the wire frame has no hole in it.
    const withoutVersion = toClientHandshakeIdentity({
      kind: "cli",
      compatibilityEpoch: 2,
      appVersion: null,
    });
    expect(Object.keys(withoutVersion).sort()).toEqual([
      "compatibilityEpoch",
      "kind",
    ]);
  });

  it("leaves epoch VALIDITY to the policy evaluator, not the wire schema", () => {
    // A non-positive / non-integer epoch must PARSE, so the host can answer
    // `invalid-epoch` with an actionable remedy instead of killing the frame
    // as malformed - which is what a `.int().positive()` here would produce.
    for (const compatibilityEpoch of [0, -3, 2.5]) {
      expect(
        clientHandshakeIdentitySchema.safeParse({ compatibilityEpoch }).success,
      ).toBe(true);
    }
    // A non-NUMBER is outside the contract and may fail the frame.
    expect(
      clientHandshakeIdentitySchema.safeParse({ compatibilityEpoch: "2" })
        .success,
    ).toBe(false);
  });

  it("does not bound kind/appVersion at parse time", () => {
    // Bounding here would turn an over-long value into the same unactionable
    // parse failure; the host normalizes for diagnostics instead.
    const parsed = clientHandshakeIdentitySchema.safeParse({
      kind: "x".repeat(4096),
      appVersion: "not a version at all",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("strict SemVer for the diagnostic version", () => {
  /**
   * COVERED HERE BECAUSE OSS CI CANNOT SEE THE PARITY SUITE.
   *
   * `isStrictSemVer` is exported protocol surface with two consumers that live
   * in the internal build repo - the host's baked-policy resolver and the
   * release stamper - and the suite that pins them against each other
   * (`scripts/__tests__/client-identity-policy-parity.test.mjs`) is in that
   * repo too. So an OSS-only change to this function has NO coverage at all
   * from this side, which is precisely the change most likely to be made by
   * someone who has never seen the internal half.
   *
   * The cases are not a sample of realistic versions: they are the exact
   * inputs on which a looser grammar differs from this one. `semver.valid`
   * accepts a leading `v` and surrounding whitespace and returns the CLEANED
   * form, and a naive `\d+` grammar accepts leading zeros - both of which
   * shipped once and produced artifacts the host refused at startup.
   */
  it.each(["1.2.0", "0.0.0", "1.2.0-rc.2", "1.2.0-rc.2+build.7", "10.20.30", "0.0.0-local"])(
    "accepts %j",
    (version) => {
      expect(isStrictSemVer(version)).toBe(true);
    },
  );

  it.each([
    ["a leading v", "v1.2.0"],
    ["leading whitespace", " 1.2.0"],
    ["trailing whitespace", "1.2.0 "],
    ["a tab", "\t1.2.0"],
    ["an embedded newline", "1.2.0\n"],
  ])("REFUSES %s (%j) - the grammar is anchored", (_label, version) => {
    // Anchoring is what makes the release stamper and the host agree: a
    // validator built on `semver.valid` accepts these and returns a cleaned
    // string, while whatever wrote the RAW value keeps the original.
    expect(isStrictSemVer(version)).toBe(false);
  });

  it.each([
    ["major", "01.2.3"],
    ["minor", "1.02.3"],
    ["patch", "1.2.03"],
    ["a numeric prerelease identifier", "1.2.3-01"],
  ])("REFUSES a leading zero in the %s (%j)", (_label, version) => {
    expect(isStrictSemVer(version)).toBe(false);
  });

  it.each(["1.2", "1", "1.2.3.4", "not-a-version", "", "1.2.0-", "1.2.0+"])(
    "REFUSES the malformed %j",
    (version) => {
      expect(isStrictSemVer(version)).toBe(false);
    },
  );

  it("accepts a version exactly at the diagnostic ceiling and refuses one past it", () => {
    // The ceiling exists because SemVer places NO bound on prerelease
    // identifiers: `1.0.0-` plus megabytes of `[0-9A-Za-z-]` is a *valid*
    // version, and this value reaches a host log line, a fatal payload, and
    // GUI copy. Asserted at the boundary so the number cannot drift silently.
    const atCeiling = `1.0.0-${"a".repeat(MAX_DIAGNOSTIC_APP_VERSION_LENGTH - "1.0.0-".length)}`;
    expect(atCeiling.length).toBe(MAX_DIAGNOSTIC_APP_VERSION_LENGTH);
    expect(isStrictSemVer(atCeiling)).toBe(true);
    expect(isStrictSemVer(`${atCeiling}a`)).toBe(false);
  });

  it("refuses an over-long version that is otherwise perfectly valid SemVer", () => {
    const overlong = `1.0.0-${"a".repeat(200)}`;
    expect(overlong.length).toBeGreaterThan(MAX_DIAGNOSTIC_APP_VERSION_LENGTH);
    expect(isStrictSemVer(overlong)).toBe(false);
  });

  it("exposes the pattern as a string so a non-TypeScript consumer can mirror it", () => {
    // The internal release scripts are CommonJS and cannot import this module,
    // so they hold a mirror keyed to this exact string. Anchors asserted
    // explicitly: dropping either is how the two would silently diverge.
    expect(STRICT_SEMVER_PATTERN.startsWith("^")).toBe(true);
    expect(STRICT_SEMVER_PATTERN.endsWith("$")).toBe(true);
    expect(new RegExp(STRICT_SEMVER_PATTERN, "u").test("1.2.0-rc.2")).toBe(true);
    expect(new RegExp(STRICT_SEMVER_PATTERN, "u").test("v1.2.0-rc.2")).toBe(
      false,
    );
  });
});

describe("clientIdentity on all three connection-open planes", () => {
  const identity = {
    kind: "desktop",
    compatibilityEpoch: CURRENT_CLIENT_COMPATIBILITY_EPOCH,
    appVersion: "1.2.0-rc.2",
  };

  it("round-trips a complete identity on the local unary open frame", () => {
    const parsed = clientOpenFrameSchema.parse({
      kind: "open",
      token: "t",
      manifest: RELEASED_MANIFEST,
      clientIdentity: identity,
    });
    expect(parsed.clientIdentity).toEqual(identity);
  });

  it("round-trips a complete identity on the local stream open frame", () => {
    const parsed = clientStreamOpenFrameSchema.parse({
      kind: "open",
      token: "t",
      manifest: RELEASED_MANIFEST,
      clientIdentity: identity,
    });
    expect(parsed.clientIdentity).toEqual(identity);
  });

  it("round-trips a complete identity on the remote session open payload", () => {
    const parsed = sessionOpenPayloadSchema.parse({
      muxVersion: 1,
      bearer: "b",
      manifest: {
        rpc: RELEASED_MANIFEST,
        optionalRpc: {},
        stream: {},
      },
      authz: null,
      resume: null,
      clientIdentity: identity,
    });
    expect(parsed.clientIdentity).toEqual(identity);
  });

  it("accepts omission on all three planes (the old-client case)", () => {
    expect(
      clientOpenFrameSchema.safeParse({
        kind: "open",
        token: "t",
        manifest: RELEASED_MANIFEST,
      }).success,
    ).toBe(true);
    expect(
      clientStreamOpenFrameSchema.safeParse({
        kind: "open",
        token: "t",
        manifest: RELEASED_MANIFEST,
      }).success,
    ).toBe(true);
    expect(
      sessionOpenPayloadSchema.safeParse({
        muxVersion: 1,
        bearer: "b",
        manifest: { rpc: RELEASED_MANIFEST, optionalRpc: {}, stream: {} },
        authz: null,
        resume: null,
      }).success,
    ).toBe(true);
  });

  it("is STRIPPED, not rejected, by a released old host's schemas", () => {
    // The new-client-to-old-host direction. A `.strict()` on either released
    // schema would have made this additive field a fleet-wide break.
    const unary = releasedClientOpenFrameSchema.parse({
      kind: "open",
      token: "t",
      manifest: RELEASED_MANIFEST,
      clientIdentity: identity,
    });
    expect(unary).not.toHaveProperty("clientIdentity");
    expect(unary.manifest).toEqual(RELEASED_MANIFEST);

    const stream = releasedClientStreamOpenFrameSchema.parse({
      kind: "open",
      token: "t",
      manifest: RELEASED_MANIFEST,
      clientIdentity: identity,
    });
    expect(stream).not.toHaveProperty("clientIdentity");
  });
});

describe("clientCompatibilityRequirement on the fatal envelope", () => {
  const fatal = {
    code: "INCOMPATIBLE",
    reason:
      "This Traycer client is too old for this host. Update the Traycer app or CLI to 1.2.0-rc.2 or newer. Updating the host again will not help. Do not reset Traycer; your agents and history remain stored.",
    incompatibleMethods: null,
    upgradeGuidance: { clientShouldUpgrade: true, hostShouldUpgrade: false },
    retryable: false,
    clientCompatibilityRequirement: REQUIREMENT,
  };

  it("round-trips through the current fatal schema", () => {
    const parsed = fatalErrorDetailsSchema.parse(fatal);
    expect(parsed.clientCompatibilityRequirement).toEqual(REQUIREMENT);
  });

  it("survives a released old client as a terminal, actionable INCOMPATIBLE", () => {
    // THE POPULATION THIS REJECTION IS AIMED AT. It cannot see the structured
    // member at all, so everything it needs has to be in the fields it keeps.
    const parsed = releasedFatalErrorDetailsSchema.parse(fatal);
    expect(parsed).not.toHaveProperty("clientCompatibilityRequirement");
    expect(parsed.code).toBe("INCOMPATIBLE");
    expect(parsed.retryable).toBe(false);
    expect(parsed.upgradeGuidance).toEqual({
      clientShouldUpgrade: true,
      hostShouldUpgrade: false,
    });
    // The reason has to carry the remedy on its own, contradict the old UI's
    // hard-coded host-update action, and rule out the destructive recovery.
    expect(parsed.reason).toContain("Update the Traycer app or CLI");
    expect(parsed.reason).toContain("Updating the host again will not help");
    expect(parsed.reason).toContain("Do not reset Traycer");
  });

  it("rejects a requirement whose minimum epoch is not a positive integer", () => {
    // Unlike the OBSERVED epoch, the host's own minimum is something the host
    // authored - a malformed one is a host bug, not a peer's claim.
    expect(
      clientCompatibilityRequirementSchema.safeParse({
        ...REQUIREMENT,
        minimumCompatibilityEpoch: 0,
      }).success,
    ).toBe(false);
    expect(
      clientCompatibilityRequirementSchema.safeParse({
        ...REQUIREMENT,
        minimumCompatibilityEpoch: 2.5,
      }).success,
    ).toBe(false);
  });
});

describe("the upgrade-channel contract as runtime values", () => {
  /**
   * The channel had a type-only export, so every RUNTIME reader outside this
   * package - a host validating its own baked config at startup, the release
   * tooling validating what it is about to stamp - had to hand-write the pair
   * of literals. These assertions are what make the exported values the single
   * definition rather than a second one that happens to agree today.
   */

  it("is the same set the wire schema accepts", () => {
    for (const channel of CLIENT_UPGRADE_CHANNELS) {
      expect(
        clientCompatibilityRequirementSchema.safeParse({
          ...REQUIREMENT,
          upgradeChannel: channel,
        }).success,
      ).toBe(true);
    }
  });

  it("rejects a channel the wire schema also rejects", () => {
    // Both directions on one value: a spelling no channel carries must fail the
    // guard AND the schema, or a host would admit a config the wire cannot
    // describe.
    expect(isClientUpgradeChannel("beta")).toBe(false);
    expect(
      clientCompatibilityRequirementSchema.safeParse({
        ...REQUIREMENT,
        upgradeChannel: "beta",
      }).success,
    ).toBe(false);
  });

  it("guards every declared channel and nothing else", () => {
    for (const channel of CLIENT_UPGRADE_CHANNELS) {
      expect(isClientUpgradeChannel(channel)).toBe(true);
    }
    for (const notAChannel of [null, undefined, 2, "", "STABLE", ["rc"]]) {
      expect(isClientUpgradeChannel(notAChannel)).toBe(false);
    }
  });
});
