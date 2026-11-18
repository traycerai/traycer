import type { AuthenticatedUser } from "@traycer/protocol/auth";

/**
 * Server time as read off an authn response's HTTP `Date` header, paired with
 * the local clock reading taken when the response landed.
 *
 * Carried on the validation result rather than reported through a side channel
 * because the fetch runs in Electron main while the consumer — the renderer's
 * clock-skew tracker — lives across an IPC boundary. This rides the reply the
 * renderer already awaits, so no new channel, no new request, and every
 * runner-host implementation (desktop IPC, mobile in-process, mock) carries it
 * for free.
 *
 * Optional throughout: a proxy that strips `Date`, or any caller predating
 * this, simply yields no sample. An absent observation must never be read as
 * "clock is fine" — see `ServerClockVerdict`'s `unknown`.
 */
export interface AuthServerTimeObservation {
  readonly serverEpochMs: number;
  readonly observedAtMs: number;
}

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
      readonly serverTime?: AuthServerTimeObservation;
    }
  | {
      readonly kind: "valid";
      readonly user: AuthenticatedUser;
      // A refresh rotates BOTH the bearer (`refreshedToken`) and the refresh
      // token (`refreshedRefreshToken`); callers must persist both.
      readonly refreshedToken: string;
      readonly refreshedRefreshToken: string;
      readonly serverTime?: AuthServerTimeObservation;
    };

export type AuthIdentityValidationResult =
  | AuthIdentityValidResult
  // `rejected` carries the observation too, and that is the case that matters
  // most: a clock hours ahead makes authn 401 the bearer it minted, so the
  // rejection IS the response that proves the clock is wrong.
  | {
      readonly kind: "rejected";
      readonly serverTime?: AuthServerTimeObservation;
    }
  | { readonly kind: "network-error" };
