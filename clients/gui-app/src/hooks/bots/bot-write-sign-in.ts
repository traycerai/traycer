import type { AuthService } from "@/lib/auth/auth-service";

/** A token rotation does not end it; signing out, switching or signing in again does. */
export interface PressSignIn {
  readonly isCurrent: () => boolean;
}

/**
 * Captured synchronously before TanStack awaits its hooks; checked before dispatch
 * and after each answer. An answer after the sign-in ended is abandoned silently.
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
