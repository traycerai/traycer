/**
 * The structured share-refusal union, and its total projection onto real
 * `RPC_ERROR_CODES` members - **`s5-share-error-taxonomy`**.
 *
 * The share gate already holds rich refusal knowledge; what it lacked was a
 * typed channel to express it. Two of its states rode `SHARE_*` PREFIXES on an
 * error message, a third (`not-owned`) was thrown but handled nowhere and fell
 * to a generic HTTP 500, and `promotion-pending` lost its reason entirely - so
 * the GUI could only ever say "Couldn't invite collaborators".
 *
 * Both facts that had justified the prefixes were checked during the audit and
 * are false: additive protocol error codes ARE old-client-safe (an
 * unrecognised code narrows to `RPC_ERROR` and the 4xx status survives), and
 * no OSS client parses those prefixes. So this is one union rather than three
 * patches, and its wire encoding is a code rather than a string convention.
 *
 * **Encoding.** The unary response error envelope is `{ code, message }`, so
 * the CODE is the only typed channel and the union projects onto it
 * one-to-one, including `promotion-pending`'s reason (each reason is a
 * separately-rendered outcome with its own retry guidance, so collapsing them
 * onto one code would re-lose exactly what this ticket recovers). `message`
 * stays what a human reads; nothing downstream parses it.
 *
 * **Fail-closed is unchanged.** Security cleared the authorization itself:
 * every share path fails closed and the gate's decision rests on the durable
 * owner verdict, not on caller input. This ticket changes the taxonomy of the
 * refusal, never its outcome.
 *
 * Suggested transport statuses for the host half (the gate's existing choices,
 * kept so the codes do not silently restate them): `needs-cloud-sync` and
 * `not-owned` are 403 (entitlement / ownership, no retry helps),
 * `promotion-pending` is 409 (busy, retriable), and the generic member is 409.
 */
import { z } from "zod";
import type { RpcErrorCode } from "@traycer/protocol/framework/index";

/**
 * Why a promotion has not finished, coarsened to the four states a user is
 * told apart. The host's own pending vocabulary is wider and process-shaped
 * (`promoting`, `retry-cooldown`, `epic-busy`, `rooms-unconfirmed`,
 * `promotion-failed`, `promotion-unavailable`, ...); this is the closed wire
 * union it maps onto:
 *
 * - `recent-attempt` - an attempt ran and has not finished or has not left its
 *   retry cooldown. It is still moving; waiting is the right advice.
 * - `busy`           - something else holds the epic (an agent turn writing
 *   into it, another attempt in flight, rooms not yet acknowledged).
 * - `offline`        - the cloud was not reachable for the attempt.
 * - `failed`         - the attempt failed, or this host cannot promote at all.
 *   The only bucket where retrying unchanged is not the advice.
 *
 * A host value with no bucket here must map to `failed` rather than be
 * dropped: silence is what the pending state already suffered from.
 */
export const epicSharePromotionPendingReasonSchema = z.enum([
  "recent-attempt",
  "busy",
  "offline",
  "failed",
]);
export type EpicSharePromotionPendingReason = z.infer<
  typeof epicSharePromotionPendingReasonSchema
>;

/**
 * Every way the share gate refuses. Mirrors the host gate's decision union
 * minus its one success arm, plus a generic member so a refusal can never
 * again be typeless - `refused` is where an unmapped or newly-added refusal
 * lands instead of falling through to a resolver-fault 500.
 */
export const epicShareRefusalSchema = z.discriminatedUnion("kind", [
  /** The epic lives only on this machine and the caller has no cloud sync. */
  z.object({ kind: z.literal("needs-cloud-sync") }),
  /** A local-homed epic created by a different account on this machine. */
  z.object({ kind: z.literal("not-owned") }),
  /** Entitled and owned, but the epic has not finished reaching the cloud. */
  z.object({
    kind: z.literal("promotion-pending"),
    reason: epicSharePromotionPendingReasonSchema,
  }),
  /** Refused for a reason this line does not model. */
  z.object({ kind: z.literal("refused") }),
]);
export type EpicShareRefusal = z.infer<typeof epicShareRefusalSchema>;

type EpicShareRefusalKind = EpicShareRefusal["kind"];

const EPIC_SHARE_REFUSAL_CODE_BY_KIND = {
  "needs-cloud-sync": "E_SHARE_NEEDS_CLOUD_SYNC",
  "not-owned": "E_SHARE_NOT_OWNED",
  refused: "E_SHARE_REFUSED",
} as const satisfies Record<
  Exclude<EpicShareRefusalKind, "promotion-pending">,
  RpcErrorCode
>;

const EPIC_SHARE_PENDING_CODE_BY_REASON = {
  "recent-attempt": "E_SHARE_PENDING_RECENT_ATTEMPT",
  busy: "E_SHARE_PENDING_BUSY",
  offline: "E_SHARE_PENDING_OFFLINE",
  failed: "E_SHARE_PENDING_FAILED",
} as const satisfies Record<EpicSharePromotionPendingReason, RpcErrorCode>;

/** The wire code for a refusal. Total: every member has one. */
export function epicShareRefusalErrorCode(
  refusal: EpicShareRefusal,
): RpcErrorCode {
  return refusal.kind === "promotion-pending"
    ? EPIC_SHARE_PENDING_CODE_BY_REASON[refusal.reason]
    : EPIC_SHARE_REFUSAL_CODE_BY_KIND[refusal.kind];
}

/**
 * The refusal a wire code denotes, or `null` when the code is not a share
 * refusal at all. A client on an older line that never learned a code reads
 * `null` here and keeps its current generic rendering - the same degrade it
 * already applies to any unrecognised code.
 */
export function epicShareRefusalFromErrorCode(
  code: string,
): EpicShareRefusal | null {
  switch (code) {
    case "E_SHARE_NEEDS_CLOUD_SYNC":
      return { kind: "needs-cloud-sync" };
    case "E_SHARE_NOT_OWNED":
      return { kind: "not-owned" };
    case "E_SHARE_PENDING_RECENT_ATTEMPT":
      return { kind: "promotion-pending", reason: "recent-attempt" };
    case "E_SHARE_PENDING_BUSY":
      return { kind: "promotion-pending", reason: "busy" };
    case "E_SHARE_PENDING_OFFLINE":
      return { kind: "promotion-pending", reason: "offline" };
    case "E_SHARE_PENDING_FAILED":
      return { kind: "promotion-pending", reason: "failed" };
    case "E_SHARE_REFUSED":
      return { kind: "refused" };
    default:
      return null;
  }
}

/** Whether a wire code belongs to the share-refusal taxonomy. */
export function isEpicShareRefusalErrorCode(code: string): boolean {
  return epicShareRefusalFromErrorCode(code) !== null;
}
