import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type { EnvironmentStatusResponse } from "@traycer/protocol/host/environment-schemas";

/** The configuration a host runs, from its `environment.status`; `null` for none. */
export type ProviderKeyPrincipal = EnvironmentStatusResponse["principal"];

/**
 * The providers whose key, saved through `providers.setApiKey` on a host
 * running Personal, becomes Personal's `provider` secret: the host forwards it
 * (`forwardProviderApiKey`) only for a provider with a server address to send
 * it to. Kiro and Droid have none, so theirs stays on the host that saved it.
 *
 * A mirror, since the wire does not carry it. Its source of truth is the
 * non-empty `providerHosts` rows of
 * `packages/common/src/sandbox-secrets/harness-profiles.ts`; a provider added
 * there is added here.
 */
const PERSONAL_SECRET_KEY_PROVIDERS: ReadonlySet<ProviderId> = new Set([
  "cursor",
  "openrouter",
  "huggingface",
  "amp",
]);

/** Whether a provider key saved on a host running `principal` becomes Personal's secret. */
export function providerKeyIsPersonalSecret(
  providerId: ProviderId,
  principal: ProviderKeyPrincipal,
): boolean {
  return (
    hostRunsPersonal(principal) && PERSONAL_SECRET_KEY_PROVIDERS.has(providerId)
  );
}

/**
 * Whether the host runs Personal, so its other computers and sandboxes are
 * worth naming as the ones the key does not reach. `false` on a Local pick,
 * on a host running a team or nothing, and before the status answers.
 */
export function hostRunsPersonal(principal: ProviderKeyPrincipal): boolean {
  return principal?.kind === "personal";
}

/** A provider-level key kept on one host only: Account tab and the composer's key paste. */
export function deviceKeyCustodyLine(
  hostName: string,
  providerLabel: string,
  envVar: string,
  runsPersonal: boolean,
): string {
  const elsewhere = runsPersonal
    ? " Other computers and sandboxes running Personal don't get this key."
    : "";
  return `Stored encrypted on ${hostName} only.${elsewhere} When no key is saved here, ${providerLabel} uses ${envVar} from ${hostName}'s shell.`;
}

/**
 * A profile's own key, kept on one host only. Personal carries the profile
 * but not its key, and a managed profile never runs on a key from the shell
 * (Antigravity, the one provider with profile keys, strips it), so on another
 * computer running Personal the profile has none.
 */
export function deviceProfileKeyCustodyLine(
  hostName: string,
  runsPersonal: boolean,
): string {
  const elsewhere = runsPersonal
    ? " The profile follows you, but this key doesn't: on other computers and sandboxes running Personal, the profile has no key."
    : "";
  return `Stored encrypted on ${hostName} only and used only by this profile.${elsewhere}`;
}
