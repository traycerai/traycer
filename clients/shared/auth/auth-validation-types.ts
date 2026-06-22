import type { AuthenticatedUser } from "@traycer/protocol/auth";

/**
 * Full-identity validation result. The `valid` variant carries the parsed
 * `AuthenticatedUser` so callers can mint a `RequestContext` directly, and
 * `refreshedToken` is set when the helper had to refresh once before the
 * lookup succeeded so the caller can persist the rotated bearer.
 */
export type AuthIdentityValidResult =
  | {
      readonly kind: "valid";
      readonly user: AuthenticatedUser;
    }
  | {
      readonly kind: "valid";
      readonly user: AuthenticatedUser;
      // A refresh rotates BOTH the bearer (`refreshedToken`) and the refresh
      // token (`refreshedRefreshToken`); callers must persist both.
      readonly refreshedToken: string;
      readonly refreshedRefreshToken: string;
    };

export type AuthIdentityValidationResult =
  | AuthIdentityValidResult
  | { readonly kind: "rejected" }
  | { readonly kind: "network-error" };
