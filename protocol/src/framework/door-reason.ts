/**
 * Why a host refused or closed a person's connection at or after the token step;
 * rides `FatalErrorDetails`, a persistent `/rpc` error answer and a relay unary
 * error. The reason, not the `code`, is the contract. A host at this protocol sets
 * it on every such refusal: absent means an older host, unknown a newer one.
 */
import { z } from "zod";

export const HOST_DOOR_REASONS = [
  "keys_unavailable",
  "clock_skew",
  "token_expired",
  "not_admitted",
  "enrolment_broken",
  "membership_removed",
  "session_revoked",
  "host_claimed",
  /**
   * The open carried {@link NO_HOST_TOKEN_PROBE}, and this door (a personal
   * computer's local door) takes its owner's sign-in now.
   */
  "owner_sign_in",
  /**
   * The open carried {@link NO_HOST_TOKEN_PROBE} on a personal computer's local
   * door, and the computer has no owner yet. Its `reason` is the host's own
   * sentence for the person.
   */
  "not_provisioned",
] as const;

export type HostDoorReason = (typeof HOST_DOOR_REASONS)[number];

const hostDoorReasonSchema = z.enum(HOST_DOOR_REASONS);

/**
 * Presented in place of a host-only token that cannot be had, never a
 * credential. A released host refuses it as it refuses any host-only token; a
 * current host names its reason, `owner_sign_in` only where that door takes the
 * owner's sign-in.
 */
export const NO_HOST_TOKEN_PROBE = "no-host-only-token";

/** Any non-empty string parses, so a newer reason reaches {@link readDoorReason}; an empty one fails the frame. */
export const doorReasonWireFieldSchema = z.string().min(1).optional();

/** `absent`: an older host. `unrecognised`: a newer one. */
export type HostDoorReasonReading = HostDoorReason | "unrecognised" | "absent";

export function readDoorReason(
  doorReason: string | undefined,
): HostDoorReasonReading {
  if (doorReason === undefined) return "absent";
  const parsed = hostDoorReasonSchema.safeParse(doorReason);
  return parsed.success ? parsed.data : "unrecognised";
}
