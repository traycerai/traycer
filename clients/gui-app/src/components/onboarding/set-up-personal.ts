import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";

/**
 * A provider this person set up: a linked plan (a signed-in account that is
 * not this computer's own sign-in) or an API key stored for it. This
 * computer's own sign-in does not count, since it is not one of the person's
 * settings.
 */
export function providerSetUp(providers: readonly ProviderCliState[]): boolean {
  return providers.some(
    (provider) =>
      (provider.apiKey.configured && provider.apiKey.source === "stored") ||
      provider.profiles.some(
        (profile) =>
          profile.kind === "managed" && profile.auth.status === "authenticated",
      ),
  );
}
