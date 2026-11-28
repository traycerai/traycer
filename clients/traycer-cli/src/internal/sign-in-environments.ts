import { isManagedCliAuth, managedSignInRefusal } from "./managed-host-auth";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type {
  EnvironmentDescriptor,
  EnvironmentOwnerKind,
} from "@traycer/protocol/host/environment/contracts";
import { readLeaseBearer } from "@traycer-clients/shared/auth/bearer-source";
import { hostSignInKey } from "@traycer-clients/shared/auth/host-token-source";
import { validateAuthTokenIdentityAccessOnly } from "../../../shared/auth/auth-validation";
import { config } from "../config";
import { cliError, CLI_ERROR_CODES, type CliError } from "../runner/errors";
import { acquireCliSignIn } from "./cli-host-tokens";
import { resolveHostAuth, type HostAuth } from "./host-auth";
import {
  AUTHN_UNREACHABLE_MESSAGE,
  hostTokenFailureCliError,
  signInRejectedCliError,
  storedCredentialRejectedCliError,
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

/** The environments of the person a command acts as: the user of the first sign-in it read. */
export interface SignedInEnvironments {
  readonly userId: string;
  readonly environments: readonly SignInEnvironment[];
}

/**
 * Read at authn when the command runs; nothing is stored. A refused sign-in is
 * refreshed once, as a mint's. `notConfirmed` is the caller's line when the
 * sign-in cannot be judged as this person's.
 */
export async function readSignInEnvironments(
  notConfirmed: () => CliError,
): Promise<SignedInEnvironments> {
  if (await isManagedCliAuth()) throw managedSignInRefusal();
  const auth = await resolveHostAuth();
  if (auth === null) throw hostTokenFailureCliError({ kind: "no-sign-in" });
  const signedIn = await storedSignInAsAuthnTakesIt(auth, notConfirmed);
  return {
    userId: auth.userId,
    environments: describeSignInEnvironments(signedIn.user),
  };
}

/** An answer refusing the sign-in it was sent. */
interface SignInRefused {
  readonly kind: "unauthorized";
}

function answered<A extends { readonly kind: string }>(
  answer: A,
): answer is Exclude<A, SignInRefused> {
  return answer.kind !== "unauthorized";
}

/**
 * The one way a command sends a stored sign-in once it knows whose it acts
 * as (`userId`): a sign-in of any other user is never sent, and the command
 * ends with the caller's `notConfirmed`.
 */
export function sendAs<A>(
  userId: string,
  auth: HostAuth,
  send: (token: string) => Promise<A>,
  notConfirmed: () => CliError,
): Promise<A> {
  if (auth.userId !== userId) return Promise.reject(notConfirmed());
  return send(auth.token);
}

/**
 * `ask` as `userId` with the sign-in sent, and, when the answer refuses that
 * sign-in, once more with that person's stored sign-in as authn takes it.
 * A refusal of a sign-in authn has just taken is `refusedAgain`; a sign-in
 * that cannot be judged as this person's is `notConfirmed`. An unreachable
 * authn is never a refusal.
 */
export async function askWithStoredSignIn<A extends { readonly kind: string }>(
  userId: string,
  auth: HostAuth,
  ask: (token: string) => Promise<A>,
  endings: {
    readonly refusedAgain: () => CliError;
    readonly notConfirmed: () => CliError;
  },
): Promise<Exclude<A, SignInRefused>> {
  const first = await sendAs(userId, auth, ask, endings.notConfirmed);
  if (answered(first)) return first;
  const judged = await storedSignInAsAuthnTakesIt(auth, endings.notConfirmed);
  const second = await sendAs(userId, judged.auth, ask, endings.notConfirmed);
  if (answered(second)) return second;
  throw endings.refusedAgain();
}

/**
 * The one issuer of sign-in advice in this module: `advice` only while the
 * store still holds the sign-in whose sent request authn refused
 * (`refusedKey`, that token's key); otherwise what is stored now.
 */
async function issuedAdvice(
  advice: CliError,
  refusedKey: string | null,
): Promise<
  | { readonly kind: "advice"; readonly advice: CliError }
  | { readonly kind: "replaced"; readonly stored: HostAuth | null }
> {
  const stored = await resolveHostAuth();
  return hostSignInKey(stored?.token ?? null) === refusedKey
    ? { kind: "advice", advice }
    : { kind: "replaced", stored };
}

/** `advice` for a refusal of `sentToken`, through the one issuer; else `notConfirmed`. */
export async function adviceForRefusedSend(
  advice: CliError,
  sentToken: string,
  notConfirmed: () => CliError,
): Promise<CliError> {
  const issued = await issuedAdvice(advice, hostSignInKey(sentToken));
  return issued.kind === "advice" ? issued.advice : notConfirmed();
}

/**
 * `auth`'s person's stored sign-in as authn takes it. Sign-in advice only
 * through {@link issuedAdvice}. A save of that person's sign-in after a
 * refusal is judged once more; a sign-in of any other user, or one still
 * undecided after that, ends with `notConfirmed`.
 */
async function storedSignInAsAuthnTakesIt(
  auth: HostAuth,
  notConfirmed: () => CliError,
): Promise<{ readonly auth: HostAuth; readonly user: AuthenticatedUser }> {
  let current = auth;
  for (let judged = 1; ; judged += 1) {
    const judgment = await judgeStoredSignIn(current);
    // The person's own lease answered: never another user's sign-in.
    if (judgment.kind === "accepted")
      return {
        auth: { ...current, token: judgment.token },
        user: judgment.user,
      };
    const issued = await issuedAdvice(judgment.advice, judgment.refusedKey);
    if (issued.kind === "advice") throw issued.advice;
    if (issued.stored === null)
      throw hostTokenFailureCliError({ kind: "no-sign-in" });
    if (issued.stored.userId !== auth.userId || judged >= 2)
      throw notConfirmed();
    current = issued.stored;
  }
}

/**
 * The stored sign-in as authn takes it: `auth`'s when authn takes that one,
 * else the one stored after one refresh. `refused` when authn refuses the
 * stored sign-in after that refresh, with the advice and `refusedKey`: the
 * key of the sign-in whose sent request authn refused (`null` when none was
 * left). An unreachable authn throws, never a refusal.
 */
async function judgeStoredSignIn(auth: HostAuth): Promise<
  | {
      readonly kind: "accepted";
      readonly token: string;
      readonly user: AuthenticatedUser;
    }
  | {
      readonly kind: "refused";
      readonly advice: CliError;
      readonly refusedKey: string | null;
    }
> {
  const first = await validateAuthTokenIdentityAccessOnly(
    config.authnBaseUrl,
    auth.token,
  );
  if (first.kind === "valid")
    return { kind: "accepted", token: auth.token, user: first.user };
  if (first.kind === "network-error") throw unreachable();
  // The person's one sign-in in this process, refreshed through its one
  // writer of the judge's facts.
  const signIn = await acquireCliSignIn(auth, null);
  try {
    const refreshed = await signIn.tokens.refreshSignIn();
    if (refreshed === "network-error") throw unreachable();
    if (refreshed === "rejected") {
      // The gate's judgement, made after its adopting read: a sign-in another
      // process saved meanwhile is read below instead.
      const rejection = await signIn.tokens.signInRejectionNow(null);
      if (rejection !== null)
        return {
          kind: "refused",
          advice: signInRejectedCliError(rejection),
          refusedKey: rejection.signIn,
        };
    }
    const token = readLeaseBearer(signIn.lease);
    // No sign-in left to send after authn answered the refresh: today's line,
    // not a host-token mint verdict, so the gate does not judge it.
    if (token === null)
      return {
        kind: "refused",
        advice: storedCredentialRejectedCliError(),
        refusedKey: null,
      };
    const second = await validateAuthTokenIdentityAccessOnly(
      config.authnBaseUrl,
      token,
    );
    if (second.kind === "valid")
      return { kind: "accepted", token, user: second.user };
    if (second.kind === "network-error") throw unreachable();
    // authn's own answer refusing this sign-in just now, not a host-token
    // mint verdict: the gate judges only those.
    return {
      kind: "refused",
      advice: storedCredentialRejectedCliError(),
      refusedKey: hostSignInKey(token),
    };
  } finally {
    signIn.dispose();
  }
}

function unreachable(): CliError {
  return cliError({
    code: CLI_ERROR_CODES.CLOUD_UNREACHABLE,
    message: AUTHN_UNREACHABLE_MESSAGE,
    details: null,
    exitCode: 1,
  });
}
