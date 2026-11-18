import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderCliState,
} from "@traycer/protocol/host/provider-schemas";

export interface SetUpHarness {
  readonly id: ProviderCliState["providerId"];
  readonly name: string;
}

/**
 * The harnesses this machine can run right now: turned on, and signed in on
 * at least one account (this computer's own sign-in or a linked one).
 * Traycer's own agent is left out, since the image already shows Traycer.
 */
export function setUpHarnesses(
  providers: ReadonlyArray<ProviderCliState>,
): ReadonlyArray<SetUpHarness> {
  return providers
    .filter(
      (provider) =>
        provider.providerId !== "traycer" &&
        provider.enabled &&
        (provider.auth.status === "authenticated" ||
          provider.profiles.some(
            (profile) => profile.auth.status === "authenticated",
          )),
    )
    .map((provider) => ({
      id: provider.providerId,
      name: PROVIDER_DISPLAY_NAMES[provider.providerId],
    }));
}
