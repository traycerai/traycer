/** The revalidator contracts the host transport depends on after a host `unauthorized`. */
import type { OpenFrameBearerSource } from "./bearer-source";

/** The recovery hook a host-RPC/stream messenger invokes after the host signals `unauthorized`. */
export interface AuthRevalidator {
  revalidateCurrentContext(): Promise<unknown>;
}

/**
 * Unary-transport auth recovery is tied to the bearer object that produced the rejected `open` frame.
 * Implementations must never refresh, rotate, or sign out a replacement context when that exact object is no longer current.
 */
export interface AuthorityBoundAuthRevalidator {
  revalidateExpectedBearer(
    expected: OpenFrameBearerSource,
  ): Promise<RevalidateOutcome | "superseded">;
}

export type RevalidateOutcome = "rotated" | "rejected" | "network-error";

/**
 * Stream-side auth recovery hook the `/stream` transport invokes after the host rejects an open frame with `unauthorized`.
 * Never a sign-out, never a terminal close.
 */
export interface StreamAuthRevalidator {
  revalidateForReconnect(): Promise<RevalidateOutcome>;
}
