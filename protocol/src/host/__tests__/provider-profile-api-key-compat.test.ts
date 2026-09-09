import { describe, expect, it } from "vitest";
import {
  splitConnectionManifest,
  SERVES_EVERY_INSTALLED_MAJOR,
} from "@traycer/protocol/framework/index";
import {
  hostRpcRegistry,
  providersClearProfileApiKeyV10,
  providersSetProfileApiKeyV10,
} from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { releasedMethodNames } from "@traycer/protocol/host/__tests__/__fixtures__/released-method-names";
import {
  providerProfileSchema,
  providersClearProfileApiKeyRequestSchema,
  providersSetApiKeyRequestSchema,
  providersSetProfileApiKeyRequestSchema,
  providersSetProfileApiKeyResponseSchema,
} from "@traycer/protocol/host/provider-schemas";

const PROFILE_SCOPED_METHODS = [
  "providers.setProfileApiKey",
  "providers.clearProfileApiKey",
] as const;

/**
 * The per-profile API-key methods ride the optional-capability channel, exactly
 * like `agent.tui.validateForkProfile` and `providers.setProfileEnabled`: a new
 * method NAME on the released floor is handshake-fatal against a peer that
 * shipped before it existed.
 *
 * Parameterised over both methods rather than written twice, so `clear` cannot
 * quietly drift onto the floor while `set` stays off it.
 *
 * ABLATION NOTE - the `degrade` arms below cannot be falsified from here, and
 * that is a property of the framework, not a hole in the test: deleting
 * `degrade` makes `validateVersionedRpcRegistryDegrades` THROW while building
 * the registry ("Non-floor method '...' must declare a degrade strategy"), so
 * the suite reports `no tests` rather than a red assertion. Those two arms are
 * therefore belt-and-braces over a structural invariant, and they still earn
 * their place by pinning WHICH strategy (`unsupported`, not a substitute or a
 * default value). The arms carrying independent weight are the manifest ones -
 * landing on `optionalManifest` and NOT on the floor manifest is the
 * observable consequence, and nothing outside this file asserts it.
 */
describe("per-profile API-key methods are optional, not floor", () => {
  it.each(PROFILE_SCOPED_METHODS)("%s is present in hostRpcRegistry", (m) => {
    expect(hostRpcRegistry[m]).toBeDefined();
    expect(hostRpcRegistry[m][1].versions[0].contract.method).toBe(m);
  });

  it.each(PROFILE_SCOPED_METHODS)(
    "%s is absent from RELEASED_FLOOR_METHOD_NAMES",
    (m) => {
      expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(m);
    },
  );

  it.each(PROFILE_SCOPED_METHODS)(
    "%s is absent from the guarded released-method-name fixture",
    (m) => {
      expect(releasedMethodNames).not.toContain(m);
    },
  );

  it.each(PROFILE_SCOPED_METHODS)(
    "%s advertises on the optional manifest at 1.0, not the floor manifest",
    (m) => {
      const split = splitConnectionManifest(
        hostRpcRegistry,
        RELEASED_FLOOR_METHOD_NAMES,
        SERVES_EVERY_INSTALLED_MAJOR,
      );
      expect(split.optionalManifest[m]).toEqual({
        major: 1,
        minor: 0,
        supportedMajors: [1],
      });
      expect(split.manifest[m]).toBeUndefined();
    },
  );

  it.each(PROFILE_SCOPED_METHODS)(
    '%s declares degrade: { kind: "unsupported" }',
    (m) => {
      const entry = hostRpcRegistry[m];
      expect(Object.hasOwn(entry, "degrade")).toBe(true);
      expect("degrade" in entry ? entry.degrade : undefined).toEqual({
        kind: "unsupported",
      });
    },
  );

  it("registers the contracts these tests name, not same-named strangers", () => {
    expect(providersSetProfileApiKeyV10.method).toBe(
      "providers.setProfileApiKey",
    );
    expect(providersClearProfileApiKeyV10.method).toBe(
      "providers.clearProfileApiKey",
    );
  });
});

/**
 * Why these are methods and not a `profileId` field on the released
 * `providers.setApiKey`.
 *
 * This is the executable half of that decision: the failure it avoids is not
 * hypothetical, it is what the released request schema does to an unknown key
 * today. A scope that is silently dropped does not degrade to "no scope" - it
 * degrades to "every profile", because the host's provider-level store is what
 * remains.
 */
describe("a profile scope cannot ride providers.setApiKey", () => {
  it("providers.setApiKey SILENTLY DROPS a profileId rather than refusing it", () => {
    const parsed = providersSetApiKeyRequestSchema.parse({
      providerId: "antigravity",
      apiKey: "key-for-one-profile",
      profileId: "profile-managed",
    });
    // Not a rejection the caller could notice and not a preserved value: the
    // key survives, its scope does not. A host reading this request stores the
    // secret provider-wide and authenticates every OTHER profile with it.
    expect(Object.hasOwn(parsed, "profileId")).toBe(false);
    expect(parsed.apiKey).toBe("key-for-one-profile");
  });

  it("CONTROL: the profile-scoped request PRESERVES the same profileId", () => {
    // Same input shape, same field name, different method - so the arm above
    // is about where the field rides, not about the field being unparseable.
    const parsed = providersSetProfileApiKeyRequestSchema.parse({
      providerId: "antigravity",
      apiKey: "key-for-one-profile",
      profileId: "profile-managed",
    });
    expect(parsed.profileId).toBe("profile-managed");
    expect(parsed.apiKey).toBe("key-for-one-profile");
  });
});

describe("per-profile API-key request/response schemas", () => {
  it("refuses an empty key rather than treating it as a clear", () => {
    const parsed = providersSetProfileApiKeyRequestSchema.safeParse({
      providerId: "antigravity",
      profileId: "profile-managed",
      apiKey: "",
    });
    expect(parsed.success).toBe(false);
  });

  it("clearing takes no key at all, so it cannot be reached by a slipped paste", () => {
    const parsed = providersClearProfileApiKeyRequestSchema.parse({
      providerId: "antigravity",
      profileId: "profile-managed",
      apiKey: "should-not-survive",
    });
    expect(Object.hasOwn(parsed, "apiKey")).toBe(false);
  });

  it("the response reports only whether a key is stored, never the key", () => {
    const parsed = providersSetProfileApiKeyResponseSchema.parse({
      profileId: "profile-managed",
      apiKey: { supported: true, configured: true },
    });
    expect(parsed.apiKey).toEqual({ supported: true, configured: true });
    // Falsification: widen `providerProfileApiKeyStateSchema` with a `value`
    // (or make the response's `apiKey` a bare string) and this reddens - the
    // state object is the only thing that comes back, and it is booleans.
    expect(
      Object.values(parsed.apiKey).every((v) => typeof v === "boolean"),
    ).toBe(true);
  });

  it("a raw key string is not a valid response state", () => {
    const parsed = providersSetProfileApiKeyResponseSchema.safeParse({
      profileId: "profile-managed",
      apiKey: "sk-live-secret",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("ProviderProfile.apiKey degrades on a host that predates it", () => {
  const baseProfile = {
    profileId: "profile-managed",
    enabled: true,
    kind: "managed" as const,
    authType: "oauth" as const,
    label: "Work account",
    auth: {
      status: "authenticated" as const,
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: { email: null, tier: null, accountUuid: null },
    usageUpdatedAt: null,
    rateLimitStatus: "unknown" as const,
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };

  it("parses a profile with no apiKey key at all", () => {
    const parsed = providerProfileSchema.parse(baseProfile);
    // Absent, not defaulted to a state object: "unknown", which the client
    // renders as no paste form - the same surface it had before the field.
    expect(parsed.apiKey ?? null).toBeNull();
  });

  it("keeps a well-formed state and does not invent one", () => {
    const parsed = providerProfileSchema.parse({
      ...baseProfile,
      apiKey: { supported: true, configured: false },
    });
    expect(parsed.apiKey).toEqual({ supported: true, configured: false });
  });

  it("degrades a malformed state to null instead of throwing away the profile", () => {
    // `.catch(null)` matters at the ARRAY level: `profiles` is `.catch([])`, so
    // a throw here would wipe every profile for this provider, not just this
    // field. Falsification: drop `.catch(null)` and this reddens.
    const parsed = providerProfileSchema.parse({
      ...baseProfile,
      apiKey: { supported: "yes", configured: 1 },
    });
    expect(parsed.apiKey).toBeNull();
  });
});
