/**
 * The revalidator contracts the host transport depends on after a host
 * `UNAUTHORIZED`. The refresh IMPLEMENTATION no longer lives here: each client
 * supplies its own revalidator over these shapes - the renderer's `AuthService`,
 * and the CLI's `createStoreBackedRevalidator` - both routing the refresh spend
 * through the locked credentials `rotate` (credentials-file token-store §7) so no
 * two processes ever double-spend a single-use refresh token.
 */
import type { OpenFrameBearerSource } from "./bearer-source";

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
 * Unary-transport auth recovery is tied to the bearer object that produced the
 * rejected `open` frame. Implementations must never refresh, rotate, or sign
 * out a replacement context when that exact object is no longer current.
 */
export interface AuthorityBoundAuthRevalidator {
  revalidateExpectedBearer(
    expected: OpenFrameBearerSource,
  ): Promise<RevalidateOutcome | "superseded">;
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
