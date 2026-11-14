/**
 * Why a host refused a person at its door, or closed their connection after
 * admitting them. It rides `doorReason` on three carriers:
 *
 *   - `FatalErrorDetails`, the one payload of the `/rpc` `fatalError` frame,
 *     the `/stream` `fatalError` frame and the relay `FATAL`;
 *   - a persistent `/rpc` session's per-request error answer, where a refused
 *     call answers on its own and the socket stays up;
 *   - a relay session's unary error answer (`UnaryResponsePayload.error`),
 *     where the call is refused and the session stays up.
 *
 * The reason is the contract and the envelope's `code` is not. A client that
 * recognises the reason decides by the reason alone. The `code` is the one an
 * older client already handles for that refusal, so a client that predates
 * the field still stops or retries correctly; a client at this protocol reads
 * the `code` only when the reason is absent or unrecognised. No pairing of a
 * code with a reason is promised, and one reason may arrive under more than
 * one code. `retryable` on the same envelope says whether to try again.
 *
 *   - `keys_unavailable`: the host could not fetch the verification keys it
 *     needs.
 *   - `clock_skew`, `token_expired`.
 *   - `not_admitted`: not the owner, not a member, another host's token, or
 *     an ownership the host no longer has or has not read yet.
 *   - `enrolment_broken`: a team host holds no valid credential of its own.
 *   - `membership_removed`, `session_revoked` (signed out everywhere) and
 *     `host_claimed`.
 *
 * A host at this protocol puts the field on every refusal or close it makes
 * about a person's host-only token, at or after the token step, so the list
 * is closed and complete. That makes its absence meaningful: such a refusal
 * without it comes from a host that predates the reasons, and a value outside
 * the list comes from a newer one. A refusal before any token is read, a
 * fatal that is not about a credential, and a host-to-host attach grant's
 * refusal carry no reason at any version. No reason carries an account
 * identifier.
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

/**
 * The wire field. Any non-empty string parses, so a newer host's reason
 * reaches {@link readDoorReason} instead of failing the frame; an older peer's
 * copy of the carrier strips the key. An empty string fails the frame.
 */
export const doorReasonWireFieldSchema = z.string().min(1).optional();

/**
 * `absent`: the host predates the reasons. `unrecognised`: the host is newer
 * than this client.
 */
export type HostDoorReasonReading = HostDoorReason | "unrecognised" | "absent";

export function readDoorReason(
  doorReason: string | undefined,
): HostDoorReasonReading {
  if (doorReason === undefined) return "absent";
  const parsed = hostDoorReasonSchema.safeParse(doorReason);
  return parsed.success ? parsed.data : "unrecognised";
}
