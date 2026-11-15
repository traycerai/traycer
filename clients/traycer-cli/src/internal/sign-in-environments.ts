import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type {
  EnvironmentDescriptor,
  EnvironmentOwnerKind,
} from "@traycer/protocol/host/environment/contracts";
import {
  MutableBearerLease,
  readLeaseBearer,
} from "@traycer-clients/shared/auth/bearer-source";
import type { RevalidateOutcome } from "@traycer-clients/shared/auth/bearer-revalidator";
import { validateAuthTokenIdentityAccessOnly } from "../../../shared/auth/auth-validation";
import { config } from "../config";
import type { CliError } from "../runner/errors";
import {
  createCliCredentialsStore,
  createStoreBackedRevalidator,
} from "../store/credentials-store";
import type { SignInRevalidator } from "./cli-host-tokens";
import { resolveHostAuth } from "./host-auth";
import { hostTokenFailureCliError } from "./host-door-words";

/** One environment the sign-in lists, as the server describes it. */
export type SignInEnvironment = Pick<
  EnvironmentDescriptor,
  "environmentId" | "ownerKind" | "ownerId" | "label"
>;

/** The label of every personal environment. */
const PERSONAL_ENVIRONMENT_LABEL = "Personal";

/**
 * Every environment the sign-in's own record lists, by the server's rule
 * (traycer-server `describeCallerEnvironments`): the personal one first, then
 * one per team ordered by label (the team's slug) and then id. A team the
 * record names no slug for (`teamSubscriptions`) is left out rather than
 * labelled with an id. A record that lists no environment yet (an older
 * authn) lists none here either.
 */
export function describeSignInEnvironments(
  user: AuthenticatedUser,
): SignInEnvironment[] {
  const owners = new Map<
    string,
    { readonly ownerKind: EnvironmentOwnerKind; readonly ownerId: string }
  >();
  if (user.environments.personal !== null) {
    owners.set(user.environments.personal, {
      ownerKind: "user",
      ownerId: user.user.id,
    });
  }
  for (const team of user.environments.teams) {
    owners.set(team.environmentId, {
      ownerKind: "organization",
      ownerId: team.teamId,
    });
  }
  const slugs = new Map(
    user.teamSubscriptions.map((subscription) => [
      subscription.team.id,
      subscription.team.slug,
    ]),
  );
  const personal: SignInEnvironment[] = [];
  const teams: SignInEnvironment[] = [];
  for (const [environmentId, owner] of owners) {
    const label =
      owner.ownerKind === "user"
        ? PERSONAL_ENVIRONMENT_LABEL
        : (slugs.get(owner.ownerId) ?? null);
    if (label === null) continue;
    (owner.ownerKind === "user" ? personal : teams).push({
      environmentId,
      ownerKind: owner.ownerKind,
      ownerId: owner.ownerId,
      label,
    });
  }
  teams.sort(
    (a, b) =>
      a.label.localeCompare(b.label) || a.ownerId.localeCompare(b.ownerId),
  );
  return [...personal, ...teams];
}

/**
 * The environments of the person signed in on this machine, read from their
 * sign-in's record at authn when the command runs. Nothing is stored.
 *
 * The same rule as a mint's: a refused sign-in is refreshed once and asked
 * once more. Only a refresh authn refused, or a second refusal, is a rejected
 * sign-in; a refresh that could not reach authn is authn unreachable.
 */
export async function readSignInEnvironments(): Promise<
  readonly SignInEnvironment[]
> {
  const auth = await resolveHostAuth();
  if (auth === null) throw hostTokenFailureCliError({ kind: "no-sign-in" });
  const first = await validateAuthTokenIdentityAccessOnly(
    config.authnBaseUrl,
    auth.token,
  );
  if (first.kind === "valid") return describeSignInEnvironments(first.user);
  if (first.kind === "network-error") throw unreachable();
  const lease = new MutableBearerLease(auth.token, auth.userId);
  const store = createCliCredentialsStore();
  // Typed to its own refresh, as the mint's is: the shared `AuthRevalidator`
  // it also satisfies declares the same method as `Promise<unknown>`.
  const revalidator: SignInRevalidator = createStoreBackedRevalidator({
    store,
    lease,
    signal: null,
  });
  let refreshed: RevalidateOutcome;
  try {
    refreshed = await revalidator.revalidateCurrentContext();
  } finally {
    store.dispose();
  }
  if (refreshed === "network-error") throw unreachable();
  if (refreshed === "rejected") throw rejected();
  const token = readLeaseBearer(lease);
  if (token === null) throw rejected();
  const second = await validateAuthTokenIdentityAccessOnly(
    config.authnBaseUrl,
    token,
  );
  if (second.kind === "valid") return describeSignInEnvironments(second.user);
  if (second.kind === "network-error") throw unreachable();
  throw rejected();
}

function rejected(): CliError {
  return hostTokenFailureCliError({ kind: "sign-in-rejected" });
}

function unreachable(): CliError {
  return hostTokenFailureCliError({
    kind: "unavailable",
    detail: "the sign-in's environments could not be read",
  });
}
