import type { AuthService } from "@/lib/auth/auth-service";

/**
 * The sign-in a direct bot write was pressed under. It has ended once the
 * person signs out, switches account or signs in again; a token rotation of
 * the same sign-in does not end it (`AuthService.getIdentityGeneration`).
 */
export interface PressSignIn {
  readonly isCurrent: () => boolean;
}

/**
 * Captured synchronously by the public mutate call, before TanStack awaits
 * its hooks; checked before dispatch as well as after each answer.
 *
 * A write answered after its sign-in ended is abandoned: it publishes
 * nothing, reads nothing again, sends nothing more and says nothing, as an
 * abandoned save does.
 */
export function pressSignIn(auth: AuthService): PressSignIn {
  const generation = auth.getIdentityGeneration();
  return { isCurrent: () => auth.isIdentityCurrent(generation) };
}

/** The service and sign-in a bot press uses together, even across a rerender. */
export interface BotWriteOrigin {
  readonly auth: AuthService;
  readonly signIn: PressSignIn;
}

export function captureBotWriteOrigin(
  auth: AuthService | null,
): BotWriteOrigin | null {
  return auth === null ? null : { auth, signIn: pressSignIn(auth) };
}
