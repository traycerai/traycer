import { useEnvironmentSecretsQuery } from "@/hooks/environment/team/use-secrets-query";
import { useHostClient } from "@/lib/host";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";

const NO_CLAIMS: ReadonlyMap<string, string> = new Map();

/**
 * The names Personal's secrets are set under on a computer running it, each
 * with the secret's name: the variables of Variables & shells. Such a name is
 * the secret's on that page, never a plain value of its own. Empty off
 * Personal, and while the secrets are not read.
 *
 * A provider's env has no equivalent: nothing binds a secret to a name in one
 * provider's env, so an override there is an ordinary value of its own.
 */
export function useSecretClaimedNames(): ReadonlyMap<string, string> {
  const personal = useEnvironmentPick().kind === "personal";
  const list = useEnvironmentSecretsQuery(useHostClient());
  if (!personal || list.isError || list.data === undefined) return NO_CLAIMS;
  const claims = new Map<string, string>();
  for (const secret of list.data.secrets) {
    for (const name of secret.variables) claims.set(name, secret.name);
  }
  return claims.size === 0 ? NO_CLAIMS : claims;
}
