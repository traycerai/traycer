import type { AuthStatus } from "@/stores/auth/auth-store";

export type LinkLoginDeepLinkRouting = "redeem" | "already-signed-in" | "hold";

/**
 * What a link code delivered by the OS should do, given what this app is
 * currently doing about auth.
 *
 * A QR scanned by the system camera arrives unannounced — the user did not ask
 * this app for anything, and may not even have it open. So unlike the in-app
 * scanner, whose result always belongs to a sign-in already in progress, this
 * has to answer for states where redeeming is wrong.
 *
 * Kept out of the bridge component so the decision can be read and tested as
 * a decision; `hold` in particular is easy to lose inside an effect, and it is
 * the branch that keeps a cold-start scan alive across the gap between "the
 * app is running" and "there is a sign-in surface to run it on".
 */
export function decideDeepLinkRouting(
  status: AuthStatus,
): LinkLoginDeepLinkRouting {
  switch (status) {
    case "signed-out":
      return "redeem";
    case "signed-in":
      // NOT a claim. Redeeming here would attach this phone to a second
      // session and swap the signed-in user underneath whatever they were
      // doing - from a QR they may well have scanned by accident, on a
      // desktop that was linking some other phone.
      return "already-signed-in";
    case "signing-in":
      // A sign-in is already in flight, and `AuthService` supersedes attempts:
      // redeeming now would cancel it in favour of a code whose approval has
      // not been given yet. Wait for it to settle - this same decision runs
      // again on the next status change, and the code is still held.
      return "hold";
    case "unverified":
      // The local plane is admitted: a stored credential we could not reach
      // authn to verify is projecting a real user id and email, and someone is
      // working against their own disk under it. So this is the `signed-in`
      // hazard, not the `signed-out` one - redeeming would attach this phone to
      // whatever account the QR names and swap that identity out from under
      // them, from a code they may have scanned by accident.
      //
      // Deliberately NOT `hold`. `hold` is for a state that settles on its own
      // in a moment; `unverified` is a durable holding state that persists for
      // as long as authn is unreachable, so holding here would strand a scan in
      // silence rather than answer it. Refusing and SAYING so is the only
      // option that neither destroys a session nor drops the user's action.
      //
      // The ROUTING is shared with `signed-in`; the SENTENCE is not - see
      // {@link linkLoginAlreadySignedInMessage}.
      return "already-signed-in";
  }
}

/**
 * What to tell someone whose scan was refused as `already-signed-in`.
 *
 * Kept beside the decision rather than in the bridge, because it is the other
 * half of it: the two admitted statuses take the same route for the same
 * reason - refusing without destroying the session - and then have to say two
 * different things, so a caller that reads only the routing has already lost
 * the distinction.
 *
 * `unverified` is the reason this function exists. "Already signed in" is a
 * claim about a session the app COULD NOT VERIFY: authn was unreachable, or it
 * answered about the token or the account and the identity is being carried on
 * a stored credential alone. Telling that user they are signed in describes a
 * verdict nobody holds - and it is the sentence they would reread later, when
 * their sync has quietly stopped, wondering why the app said everything was
 * fine.
 */
export function linkLoginAlreadySignedInMessage(status: AuthStatus): string {
  return status === "unverified"
    ? "This phone already has a stored session — nothing to approve."
    : "Already signed in on this phone — nothing to approve.";
}
