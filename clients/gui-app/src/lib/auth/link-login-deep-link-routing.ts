import type { AuthStatus } from "@/stores/auth/auth-store";

export type LinkLoginDeepLinkRouting = "redeem" | "already-signed-in" | "hold";

/** What a link code delivered by the OS should do, given what this app is currently doing about auth. */
export function decideDeepLinkRouting(
  status: AuthStatus,
): LinkLoginDeepLinkRouting {
  switch (status) {
    case "signed-out":
      return "redeem";
    case "signed-in":
      // NOT a claim.
      // Redeeming here would attach this phone to a second session and swap the signed-in user underneath whatever they were doing - from a QR they may well have scanned by accident, on a desktop that was linking some other phone.
      return "already-signed-in";
    case "signing-in":
      // A sign-in is already in flight, and `AuthService` supersedes attempts: redeeming now would cancel it in favour of a code whose approval has not been given yet.
      // Wait for it to settle - this same decision runs again on the next status change, and the code is still held.
      return "hold";
  }
}
