/**
 * Shared refresh-on-401 core: refresh the bearer, rotate the active lease, and
 * persist the rotated value - the flow both the Desktop renderer and the CLI
 * must follow. The HTTP refresh primitive (`refreshAuthTokenViaHttp`) and the
 * `rotateAndPersistBearer` step live here so neither client hand-rolls them; the
 * per-environment persistence backend is injected as a `BearerStore`.
 */
import type { StoredAuthTokens } from "../platform/runner-host";
import { refreshAuthTokenViaHttp } from "./auth-validation";
import type { BearerLease } from "./bearer-source";

/**
 * The recovery hook a host-RPC/stream messenger invokes after the host
 * signals `UNAUTHORIZED`. Returns void-ish - the auth-aware wrapper decides
 * whether to retry by observing whether the bearer actually rotated, not by the
 * return value, so the renderer's `AuthService` (which returns its own outcome
 * type) and the CLI's revalidator both satisfy this shape.
 */
export interface AuthRevalidator {
  revalidateCurrentContext(): Promise<unknown>;
}

/**
 * Per-environment bearer persistence. `read` exists (not just write) so the
 * shared refresh path can coordinate with concurrent writers - the CLI's file
 * is shared across sibling processes and the Desktop re-seeding it, so a
 * concurrently-rotated token must be adopted rather than clobbered.
 */
export interface BearerStore {
  read(): Promise<StoredAuthTokens | null>;
  write(tokens: StoredAuthTokens): Promise<void>;
  clear(): Promise<void>;
}

export type RevalidateOutcome = "rotated" | "rejected" | "network-error";

/**
 * Stream-side auth recovery hook the `/stream` transport invokes after the
 * host rejects an open frame with `UNAUTHORIZED`. Returns the normalized
 * outcome the transport acts on:
 *
 *   - "rotated":       the credential is current (refreshed, or still valid) →
 *                      re-dial; the next open frame carries the live bearer.
 *   - "network-error": transient (the bearer is untouched) → stay in reconnect
 *                      backoff and revalidate again on the next cycle. Never a
 *                      sign-out, never a terminal close.
 *   - "rejected":      the credential is dead (revoked / expired refresh token)
 *                      and the revalidator has already signed out → terminal.
 *
 * This is distinct from `AuthRevalidator` (whose `unknown` return the unary
 * `AuthAwareMessenger` deliberately ignores in favour of a before/after bearer
 * comparison). The stream must key on the OUTCOME KIND instead, because
 * `revalidateCurrentContext` is single-flight and a wake `reconnectAll` drops
 * every session at once: a session re-reading the lease *after* a sibling's
 * shared refresh already rotated it would see no change and wrongly skip its
 * retry. The shared single-flight call underneath is the same mechanism unary
 * RPC uses — only the way each transport reacts to the result differs.
 */
export interface StreamAuthRevalidator {
  revalidateForReconnect(): Promise<RevalidateOutcome>;
}

/**
 * Persist the rotated bearer, then rotate the active lease so the next open
 * frame reads it. Persist-before-rotate so a crash can't leave an in-memory
 * bearer that was never written. Shared by the CLI revalidator and the
 * renderer's `AuthService` same-user refresh branch.
 */
export async function rotateAndPersistBearer(args: {
  readonly newTokens: StoredAuthTokens;
  readonly rotate: (token: string) => void;
  readonly persist: (tokens: StoredAuthTokens) => Promise<void>;
}): Promise<void> {
  await args.persist(args.newTokens);
  // The lease carries only the bearer (the Authorization header value); the
  // refresh token lives in the store, not the lease.
  args.rotate(args.newTokens.token);
}

/**
 * Builds the shared refresh-on-401 revalidator over an injected `BearerStore`.
 *
 * On `revalidateCurrentContext()`:
 *   1. Re-read the store. If it already holds a *different* token than the one
 *      we hold, a concurrent writer rotated - adopt it instead of spending
 *      another single-use refresh token.
 *   2. Otherwise refresh once against the authn service. Re-read again before
 *      writing: if a sibling rotated *during* the round trip, adopt theirs
 *      rather than clobbering it; else persist our rotation.
 *   3. Rotate the active lease to whichever token we settled on.
 *
 * `clearOnReject` controls whether a rejected refresh wipes the store: the
 * renderer signs the user out (true); the CLI leaves credentials in place so a
 * transient authn outage doesn't force a re-login (false).
 */
export function createBearerRevalidator(args: {
  readonly authnBaseUrl: string;
  readonly lease: BearerLease;
  readonly store: BearerStore;
  readonly clearOnReject: boolean;
}): AuthRevalidator & {
  revalidateCurrentContext(): Promise<RevalidateOutcome>;
} {
  return {
    async revalidateCurrentContext(): Promise<RevalidateOutcome> {
      // Boundary helper contract: never throws - like `refreshAuthTokenViaHttp`,
      // every failure (including store I/O errors) maps to an outcome so the
      // single caller (auth-aware messenger / monitor) can decide recovery
      // without a try/catch and without risking an unhandled rejection.
      try {
        const current = args.lease.getBearerToken();

        const before = await args.store.read();
        if (
          before !== null &&
          before.token.length > 0 &&
          before.token !== current
        ) {
          args.lease.rotate(before.token);
          return "rotated";
        }

        // The refresh token pairs with the persisted bearer; without it the
        // `/api/v3/auth/refresh` body would be empty (a guaranteed 400). No stored
        // refresh token means there is nothing to refresh against.
        const refreshToken = before?.refreshToken;
        if (refreshToken === undefined || refreshToken.length === 0) {
          if (args.clearOnReject) {
            await args.store.clear();
          }
          return "rejected";
        }

        const result = await refreshAuthTokenViaHttp(
          args.authnBaseUrl,
          current,
          refreshToken,
        );
        if (result.kind === "network-error") {
          return "network-error";
        }
        if (result.kind === "rejected") {
          if (args.clearOnReject) {
            await args.store.clear();
          }
          return "rejected";
        }

        const latest = await args.store.read();
        // A non-empty token that differs from both our pre-refresh token and our
        // freshly-minted one means a sibling rotated mid-round-trip - adopt
        // theirs. The `length > 0` guard mirrors the `before` branch so a
        // concurrent `logout`/partial-write that left an empty token can't make
        // us rotate the live lease to "".
        const siblingRotated =
          latest !== null &&
          latest.token.length > 0 &&
          latest.token !== current &&
          latest.token !== result.token;
        if (siblingRotated) {
          args.lease.rotate(latest.token);
          return "rotated";
        }
        await rotateAndPersistBearer({
          newTokens: { token: result.token, refreshToken: result.refreshToken },
          rotate: (token) => args.lease.rotate(token),
          persist: (tokens) => args.store.write(tokens),
        });
        return "rotated";
      } catch {
        // Local I/O failure (e.g. credentials write) - treat as a transient
        // outcome that leaves the bearer untouched, never a thrown error.
        return "network-error";
      }
    },
  };
}
