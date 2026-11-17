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
] as const;

export type HostDoorReason = (typeof HOST_DOOR_REASONS)[number];

const hostDoorReasonSchema = z.enum(HOST_DOOR_REASONS);

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
