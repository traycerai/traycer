/**
 * Asking a host whether an epic it may or may not have created actually exists.
 *
 * The condition this answers is the ambiguous post-send drop: `epic.create`
 * went out, the response did not come back, and until now the only honest thing
 * the client could say was "this may or may not have gone through". That
 * sentence is only honest while the outcome is UNKNOWABLE, and it stopped being
 * unknowable the moment the create started carrying `idempotencyKey = epicId` -
 * the epic has a name the host can be asked about, so looking is strictly
 * better than hedging. The same applies to a `keyReuseConflict` (409), which
 * says the host has already seen this key and therefore already ran something
 * under it.
 *
 * WHY IT IS A POLL AND NOT ONE PROBE. A dropped response does not mean the
 * request died: the host may still be finishing the create (or the transport
 * may still be replaying it under the key) when the first probe lands, so one
 * `confirmed-absent` proves nothing. The loop keeps asking until the epic turns
 * up or the budget runs out, and only the LAST reading decides.
 *
 * THE VERDICT IS THREE-VALUED on purpose and only `exists` is actionable:
 * `absent` and `unknown` are different facts that warrant the same behaviour
 * (today's teardown and today's toast), because a poll that never got an answer
 * leaves the outcome exactly as ambiguous as it was before. Suppressing the
 * notice on anything but a positive find would trade a vague sentence for
 * silence, which is the trade this whole mechanism exists to avoid.
 */
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import {
  HostRpcError,
  isTransientHostRpcFailure,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { RpcErrorCode } from "@traycer/protocol/framework";
import {
  isConfirmedAbsentTaskContext,
  isFoundTaskContext,
} from "@traycer/protocol/host/epic/unary-schemas";

import { isUnknownOutcomeTransportFailure } from "@/lib/host-error-toast";
import type { HostRpcRegistry } from "@/lib/host";
import { isIdempotencyKeyReuseConflict } from "@/lib/host/idempotency-key-reuse-conflict";

export type EpicExistenceVerdict = "exists" | "absent" | "unknown";

/**
 * The keyed-idempotency error codes that mean "the host may already have done
 * this", and therefore that looking beats hedging.
 *
 * The enum is declared in `protocol/src/framework/versioned-rpc-types.ts`, and
 * its own comments there are what this list is derived from - it is a reading of
 * the three-way taxonomy, not a guess:
 *
 *  - `E_IDEMPOTENCY_OUTCOME_UNKNOWN` - the original execution passed the host's
 *    in-flight replay ceiling, so the host "can no longer promise a committed or
 *    rejected answer". Genuinely ambiguous, which is precisely this poll's case.
 *  - `E_IDEMPOTENCY_REPLAY_TOO_LARGE` - the original "SETTLED", and only its
 *    response was too large to retain. So the create almost certainly LANDED and
 *    the poll will find it; narrating this one as a failure is the worst answer
 *    available, because it is the one case where we know the command ran.
 *
 * DELIBERATELY ABSENT, and it must stay absent: `E_IDEMPOTENCY_CACHE_SATURATED`
 * carries the opposite guarantee - "the command definitely did not run and may
 * retry with the SAME key" - so it already knows its own answer and polling for
 * a minute before saying so would only delay the message.
 *
 * Typed as the wire union rather than `string` so a typo is a compile error
 * instead of a member that silently never matches.
 */
const DECIDABLE_IDEMPOTENCY_CODES: ReadonlySet<RpcErrorCode> = new Set([
  "E_IDEMPOTENCY_OUTCOME_UNKNOWN",
  "E_IDEMPOTENCY_REPLAY_TOO_LARGE",
]);

/**
 * Whether a failed keyed `epic.create` is worth asking the host about.
 *
 * THREE conditions qualify, and all three are "the host may already have done
 * this": the ambiguous post-send drop (the frame went out, the reply did not
 * come back), the two typed idempotency codes above, and the `keyReuseConflict`,
 * which is the host saying it has seen this key before. Everything else - a
 * pre-send refusal carrying the host's no-dispatch guarantee, a caller abort, a
 * version-floor refusal, an ordinary typed host error - already knows its own
 * answer.
 *
 * WHY A CODE CHECK SITS BESIDE A PROSE MATCH, since the pairing looks
 * inconsistent. It is a VERSION seam, not a taxonomy one. All three outcomes
 * are declared wire vocabulary now: `keyReuseConflict` carries
 * `IDEMPOTENCY_KEY_REUSE` alongside the two codes above, and
 * `isIdempotencyKeyReuseConflict` matches that code FIRST. The shared message
 * fragment survives underneath it only as the older-host fallback - a host
 * that predates the code still answers with the generic `RPC_ERROR` and prose
 * is the only thing that distinguishes it there. So the fragment is a
 * compatibility tier with a sunset, not a second way of classifying, and new
 * code should never reach for it directly.
 *
 * A TRANSPORT STATUS WOULD NOT HELP, which is worth recording because it is the
 * obvious thing to reach for: `HostRpcError` carries `code`, `requestId`,
 * `method`, `fatalDetails` and the worktree-holder fields, and no status - the
 * host's `DispatchOutcome.status` is consumed host-side for routing and never
 * enters the response envelope. Nor would it narrow anything if it were
 * transmitted: `keyReuseConflict`, `outcomeTooLarge` and `outcomeUnknown` are
 * that host module's three 409s - one of them the very thing the prose match
 * exists to pick out - so a status test would have to be conjoined with one of
 * these checks anyway and would narrow nothing on its own.
 *
 * Shared by the two arms that react to the same failure (the mutation's notice
 * and the landing submission's teardown) so they cannot disagree about whether
 * the question is even open.
 */
export function createOutcomeIsDecidable(error: HostRpcError): boolean {
  return (
    isUnknownOutcomeTransportFailure(error) ||
    DECIDABLE_IDEMPOTENCY_CODES.has(error.code) ||
    isIdempotencyKeyReuseConflict(error)
  );
}

/** How long the poll keeps asking before it answers with its last reading. */
export const EPIC_EXISTENCE_POLL_BUDGET_MS = 60_000;

/**
 * Backoff between probes, in milliseconds, with the last value repeating.
 *
 * Front-loaded because the overwhelmingly common answer is "it landed": the
 * response was lost, not the request, so the first or second probe finds the
 * epic and the user waits a second rather than a minute. The tail spreads the
 * remaining probes over the budget instead of putting thirty requests on a link
 * that has just proven unreliable.
 */
const PROBE_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000];
const MAX_PROBE_BACKOFF_MS = 8_000;

/** Just the verb this needs; a full `HostClient` satisfies it structurally. */
export interface EpicExistenceClient {
  readonly request: HostRequester<HostRpcRegistry>["request"];
}

/**
 * In-flight polls, keyed by host and epic.
 *
 * One dropped create produces TWO askers - the mutation's `onError`, which owns
 * the notice, and the landing submission's `.catch`, which owns the local
 * teardown - and they must reach the same verdict from the same evidence. A
 * second independent poll would double the request traffic and could answer
 * differently, leaving the epic placed and the handoff failed at once.
 */
const pollsInFlight = new Map<string, Promise<EpicExistenceVerdict>>();

export function resetEpicExistencePollForTests(): void {
  pollsInFlight.clear();
}

export function pollEpicExistence(input: {
  readonly client: EpicExistenceClient | null;
  readonly hostId: string | null;
  readonly epicId: string;
}): Promise<EpicExistenceVerdict> {
  const { client, hostId, epicId } = input;
  // Nothing to ask, so nothing is known. Not `absent`: a create dispatched on a
  // client this hook can no longer resolve may well have landed.
  if (client === null || hostId === null) {
    return Promise.resolve<EpicExistenceVerdict>("unknown");
  }
  // NUL-joined, the way every other composite key in this renderer is: no
  // host or epic id can contain one, so two different pairs cannot collide on
  // a shared separator.
  const key = `${hostId}\0${epicId}`;
  const existing = pollsInFlight.get(key);
  if (existing !== undefined) return existing;
  const started = runPoll(client, epicId).finally(() => {
    pollsInFlight.delete(key);
  });
  pollsInFlight.set(key, started);
  return started;
}

async function runPoll(
  client: EpicExistenceClient,
  epicId: string,
): Promise<EpicExistenceVerdict> {
  const deadline = Date.now() + EPIC_EXISTENCE_POLL_BUDGET_MS;
  let verdict: EpicExistenceVerdict = "unknown";
  for (let attempt = 0; ; attempt += 1) {
    const reading = await probeWithinDeadline(client, epicId, deadline);
    if (reading === "exists") return "exists";
    if (reading === "give-up") return "unknown";
    // The budget ran out with a probe still on the wire. Answer with the last
    // reading now; the abandoned request settles into nothing.
    if (reading === "deadline") return verdict;
    verdict = reading;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return verdict;
    // CLAMPED to what is left, or the budget is a suggestion: the unclamped
    // backoff puts probes at 0,1,3,7,15,23,31,39,47,55 and then 63 seconds -
    // the 55s one sees 55 < 60, sleeps a full 8, and the poll answers three
    // seconds after the minute it promised. The caller's notice is waiting on
    // this.
    await delay(Math.min(backoffMs(attempt), remaining));
  }
}

/**
 * One probe, abandoned if the budget expires while it is still in flight.
 *
 * A dropped response is the condition this whole module exists for, so the
 * probe that asks about it is itself liable to hang - and the deadline check
 * used to sit AFTER the await, which made the real bound "60 seconds plus one
 * RPC timeout" rather than 60 seconds. `EPIC_EXISTENCE_POLL_BUDGET_MS` is a
 * promise to a person watching a toast that has not appeared yet, so it is
 * enforced against the wall clock rather than against the loop's good
 * behaviour.
 *
 * The abandoned request is NOT cancelled: this reader takes only `request`, and
 * widening it to carry a signal would put a cancellation channel into an
 * interface whose whole purpose is one read-only question. It settles, nobody
 * is listening, and it costs one in-flight unary that the host was answering
 * anyway.
 */
type ProbeReading = EpicExistenceVerdict | "give-up" | "deadline";

async function probeWithinDeadline(
  client: EpicExistenceClient,
  epicId: string,
  deadline: number,
): Promise<ProbeReading> {
  const remaining = deadline - Date.now();
  // Never issue a request the budget has no room for. This is also what makes
  // the clamped sleep above terminate rather than re-probe at the deadline.
  if (remaining <= 0) return "deadline";
  // `window.setTimeout`, not the ambient one, so the handle is a plain number
  // rather than a platform-dependent object.
  //
  // A `number` rather than `number | null`, and that is a fix to the TYPE, not
  // a silenced check. The executor of `new Promise` runs SYNCHRONOUSLY during
  // construction, so the handle is always written before the `try` below is
  // entered - the nullable spelling described a state this function cannot be
  // in, which is why the `expiry !== null` that used to guard the clear could
  // never fire. `0` is not a handle any browser mints, and clearing an unknown
  // handle is a no-op, so even the one path that could leave it unwritten - an
  // executor that throws, which rejects the promise rather than throwing here -
  // still clears safely.
  let expiry = 0;
  const expired = new Promise<ProbeReading>((resolve) => {
    expiry = window.setTimeout(() => {
      resolve("deadline");
    }, remaining);
  });
  try {
    return await Promise.race([probe(client, epicId), expired]);
  } finally {
    window.clearTimeout(expiry);
  }
}

function backoffMs(attempt: number): number {
  // `.at`, not `[]`: without `noUncheckedIndexedAccess` a plain index read is
  // typed as `number` however far past the end it is, so the `??` below would
  // be dead code at compile and `undefined` at run time - which `setTimeout`
  // reads as 0 ms and turns the tail of this poll into a spin.
  return PROBE_BACKOFF_MS.at(attempt) ?? MAX_PROBE_BACKOFF_MS;
}

/**
 * `give-up` is the fourth reading and it is not a verdict: it means asking
 * again cannot help. A host that does not carry `epic.getTaskContexts`
 * (`E_HOST_UNSUPPORTED`) or that refuses the call answers the same way on every
 * retry, so the loop stops and the caller gets `unknown` now rather than in a
 * minute.
 */
async function probe(
  client: EpicExistenceClient,
  epicId: string,
): Promise<EpicExistenceVerdict | "give-up"> {
  try {
    const response = await client.request("epic.getTaskContexts", {
      taskIds: [epicId],
    });
    const resolution = response.tasks[epicId];
    if (isFoundTaskContext(resolution)) return "exists";
    return isConfirmedAbsentTaskContext(resolution) ? "absent" : "unknown";
  } catch (error: unknown) {
    if (error instanceof HostRpcError && !isTransientHostRpcFailure(error)) {
      return "give-up";
    }
    return "unknown";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
