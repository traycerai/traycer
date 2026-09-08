import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";

/**
 * The one `providers.list@9.0` profile row every test in this package builds
 * from. `overrides` replaces whole fields; anything not named takes the
 * "nothing configured" default below, which is a REAL row shape and not a
 * loosened type - the wire's own `.nullable()` value for each key, never a
 * cast past a required field (implementer rule 12).
 *
 * It exists so the next required row field is a one-file change: the wave-2
 * row gained `endpoint` and `config` as required-and-nullable, which broke
 * every hand-written literal in the package at once. Add a field HERE with
 * its null default and the hundred call sites keep compiling.
 */
export function providerProfileFixture(
  overrides: Partial<ProviderProfile>,
): ProviderProfile {
  return {
    profileId: "ambient",
    kind: "ambient",
    authType: "oauth",
    label: "Terminal account",
    auth: { status: "unknown", badgeText: null, label: null, detail: null },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    ambientDriftNotice: null,
    accentColor: null,
    reusedTombstone: null,
    enabled: true,
    launchCommand: null,
    endpoint: null,
    config: null,
    ...overrides,
  };
}
