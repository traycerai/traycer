import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type { EnvironmentPlan } from "@traycer/protocol/host/environment/configuration-contracts";
import type { EnvironmentSecret } from "@traycer/protocol/host/environment-schemas";

/**
 * The variable a team's `provider` secret is named for, per provider: a
 * provider secret's name is its provider's key variable, and authn refuses
 * any other name. Only these providers take a team key.
 */
const PROVIDER_KEY_SECRET_NAMES: Partial<Record<ProviderId, string>> = {
  cursor: "CURSOR_API_KEY",
  kiro: "KIRO_API_KEY",
  droid: "FACTORY_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  huggingface: "HF_TOKEN",
  amp: "AMP_API_KEY",
};

/**
 * A team's Providers rail word for a provider, the first rule that holds
 * winning:
 *
 * - `plan`: an admin's plan is linked for the provider's harness;
 * - `key`: a live team key is set for the provider;
 * - `no plan`: neither, so the provider can't run on the team's hosts.
 *
 * `null` while either read is still out, so the rail never states a guess.
 */
export function teamProviderStateWord(input: {
  readonly providerId: ProviderId;
  readonly harnessId: string;
  readonly plans: readonly EnvironmentPlan[] | null;
  readonly secrets: readonly EnvironmentSecret[] | null;
}): string | null {
  if (input.plans === null || input.secrets === null) return null;
  const linked = input.plans.some(
    (plan) => plan.harness === input.harnessId && plan.status === "linked",
  );
  if (linked) return "plan";
  const keyName = PROVIDER_KEY_SECRET_NAMES[input.providerId];
  const keyed =
    keyName !== undefined &&
    input.secrets.some(
      (secret) =>
        secret.kind === "provider" &&
        secret.name === keyName &&
        secret.state === "live" &&
        !secret.revoked,
    );
  if (keyed) return "key";
  return "no plan";
}
