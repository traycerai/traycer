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
 * Read in the mutation function before its first await. These writes take no
 * scope and the app's mutations never pause (`networkMode: "always"`), so a
 * mutation function starts in its press's own task and this is the press's
 * sign-in.
 *
 * A write answered after its sign-in ended is abandoned: it publishes
 * nothing, reads nothing again, sends nothing more and says nothing, as an
 * abandoned save does.
 */
export function pressSignIn(auth: AuthService): PressSignIn {
  const generation = auth.getIdentityGeneration();
  return { isCurrent: () => auth.isIdentityCurrent(generation) };
}
