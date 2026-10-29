import type { ProviderId } from "@traycer/protocol/host/provider-ids";
import { useEnvironmentSecretsQuery } from "@/hooks/environment/team/use-secrets-query";
import { useHostClient } from "@/lib/host";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";

const NO_CLAIMS: ReadonlyMap<string, string> = new Map();
const NO_SECRET_NAMES: ReadonlySet<string> = new Set();

/**
 * The names Personal's secrets are set under on a computer running it, each
 * with the secret's name: the variables of Variables & shells (`target`
 * "variable"), or one provider's env. Such a name is the secret's on that
 * page, never a plain value of its own. Empty off Personal, and while the
 * secrets are not read.
 */
export function useSecretClaimedNames(
  target:
    | { readonly kind: "variable" }
    | { readonly kind: "provider"; readonly providerId: ProviderId },
): ReadonlyMap<string, string> {
  const personal = useEnvironmentPick().kind === "personal";
  const list = useEnvironmentSecretsQuery(useHostClient());
  if (!personal || list.isError || list.data === undefined) return NO_CLAIMS;
  const claims = new Map<string, string>();
  for (const secret of list.data.secrets) {
    const names =
      target.kind === "variable"
        ? secret.variables
        : secret.providerVariables
            .filter((bound) => bound.providerId === target.providerId)
            .map((bound) => bound.name);
    for (const name of names) claims.set(name, secret.name);
  }
  return claims.size === 0 ? NO_CLAIMS : claims;
}

/**
 * Every Personal secret's own name, regardless of what it binds: a variable
 * that merely shares a secret's name, without being one of the names it is
 * set under, shadows it rather than being claimed by it. Empty off Personal,
 * and while the secrets are not read.
 */
export function useSecretNames(): ReadonlySet<string> {
  const personal = useEnvironmentPick().kind === "personal";
  const list = useEnvironmentSecretsQuery(useHostClient());
  if (!personal || list.isError || list.data === undefined)
    return NO_SECRET_NAMES;
  const names = new Set(list.data.secrets.map((secret) => secret.name));
  return names.size === 0 ? NO_SECRET_NAMES : names;
}
