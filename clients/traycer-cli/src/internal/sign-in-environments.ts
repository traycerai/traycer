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
import { cliError, CLI_ERROR_CODES, type CliError } from "../runner/errors";
import {
  createCliCredentialsStore,
  createStoreBackedRevalidator,
} from "../store/credentials-store";
import type { SignInRevalidator } from "./cli-host-tokens";
import { resolveHostAuth } from "./host-auth";
import {
  AUTHN_UNREACHABLE_MESSAGE,
  hostTokenFailureCliError,
} from "./host-door-words";

export type SignInEnvironment = Pick<
  EnvironmentDescriptor,
  "environmentId" | "ownerKind" | "ownerId" | "label"
>;

const PERSONAL_ENVIRONMENT_LABEL = "Personal";

/**
 * The server's rule: personal first, then teams by slug and id. A team the record
 * names no slug for is left out rather than labelled with an id.
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

/** Read at authn when the command runs; nothing is stored. A refused sign-in is refreshed once, as a mint's. */
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
  return cliError({
    code: CLI_ERROR_CODES.CLOUD_UNREACHABLE,
    message: AUTHN_UNREACHABLE_MESSAGE,
    details: null,
    exitCode: 1,
  });
}
