import type { CommandSendFailure } from "@traycer-clients/shared/replica-runtime";

/**
 * First re-drive delay for a host that refused a write because its idempotency
 * cache was full, doubled per attempt by the queue and clamped by
 * `COMMAND_SELF_RETRY_MAX_DELAY_MS`.
 *
 * Saturation is a load condition, not a fault: the entries that make room are
 * the ones ahead of this command retiring, so the useful wait is on the order
 * of seconds. Short enough that an ordinary burst clears without the user
 * noticing, long enough that a host under sustained pressure is not re-asked
 * on every tick.
 */
const COMMAND_SATURATION_RETRY_BASE_MS = 2_000;

/**
 * First re-drive delay for a write whose unary dial kept failing while this
 * epic's lanes stayed up, doubled per attempt by the queue on the same clamp.
 *
 * `DEFAULT_TRANSPORT_RETRY_POLICY`'s own schedule tops out at `maxDelayMs`
 * (2s) and gives up after three attempts spanning well under a second, so
 * starting here resumes where the transport stopped rather than underneath it.
 *
 * Separate from {@link COMMAND_SATURATION_RETRY_BASE_MS} despite the equal
 * value, because the two are tuned against different signals: one is a host
 * that answered "my replay cache is full", the other a socket that never
 * opened. Moving one to fit its signal must not silently move the other.
 */
const COMMAND_DIAL_RETRY_BASE_MS = 2_000;
import {
  HostRpcError,
  HostTransportFailureError,
  RetryableTransportError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { StaleHostBindingAuthorityError } from "@traycer-clients/shared/host-client/host-binding-authority-error";
import {
  commonRecordRegistry,
  type TicketStatus,
} from "@traycer/protocol/common/registry";
import { getRecordSchema } from "@traycer/protocol/framework/versioned-record";

/** The registry's own vocabulary, never a copy of it. */
const ticketStatusSchema = getRecordSchema(
  commonRecordRegistry,
  "ticket-status",
  "latest",
);

export type EpicWriteCommandIntent =
  | {
      readonly kind: "rename-artifact";
      readonly artifactId: string;
      readonly title: string;
    }
  | {
      readonly kind: "delete-artifact";
      readonly artifactId: string;
    }
  | {
      readonly kind: "reparent-artifact";
      readonly artifactId: string;
      readonly parentId: string | null;
    }
  | {
      readonly kind: "update-artifact-status";
      readonly artifactId: string;
      readonly artifactType: "ticket" | "story";
      readonly status: TicketStatus;
    }
  | {
      readonly kind: "update-epic-title";
      readonly title: string;
      readonly updatedAt: number;
    };

/**
 * The intent's wire form, narrowed.
 *
 * It crosses `command/enqueue` as `unknown` for the same reason
 * `main/write-command`'s does - it is the caller's clonable form and the
 * worker carries it opaquely - but the QUEUE is typed, so one side has to
 * narrow. Here, beside the union, so a member added above is one arm away from
 * the parser that has to accept it.
 *
 * `status` is validated with the REGISTRY's own schema rather than a list of
 * literals copied out of it: `TicketStatus` is registry-derived, and a copied
 * vocabulary rots against the registry the moment a status is added - silently,
 * by refusing a status the rest of the app accepts.
 *
 * Unrecognised payloads answer `null`, and the caller turns that into a
 * REFUSAL rather than an error. Enqueuing a malformed intent would mint an id
 * for a command that can never be dispatched, which is the never-settles hang.
 */
/**
 * The ARTIFACT-shaped intents: every one keyed by an `artifactId`.
 *
 * Split from the epic-title arm below because `complexity` counts each `case`,
 * and one switch over five kinds cleared the cap without any single decision
 * being hard. The split is by SUBJECT - what the intent names - rather than an
 * arbitrary halving, so a new intent has an obvious home.
 */
function readArtifactIntent(
  value: object,
  kind: string,
): EpicWriteCommandIntent | null {
  const artifactId: unknown = Reflect.get(value, "artifactId");
  if (typeof artifactId !== "string") return null;
  const title: unknown = Reflect.get(value, "title");
  switch (kind) {
    case "rename-artifact":
      return typeof title === "string"
        ? { kind: "rename-artifact", artifactId, title }
        : null;
    case "delete-artifact":
      return { kind: "delete-artifact", artifactId };
    case "reparent-artifact": {
      const parentId: unknown = Reflect.get(value, "parentId");
      if (parentId !== null && typeof parentId !== "string") return null;
      return { kind: "reparent-artifact", artifactId, parentId };
    }
    case "update-artifact-status": {
      const artifactType: unknown = Reflect.get(value, "artifactType");
      const status = ticketStatusSchema.safeParse(Reflect.get(value, "status"));
      if (!status.success) return null;
      if (artifactType !== "ticket" && artifactType !== "story") return null;
      return {
        kind: "update-artifact-status",
        artifactId,
        artifactType,
        status: status.data,
      };
    }
    default:
      return null;
  }
}

export function readWriteCommandIntent(
  value: unknown,
): EpicWriteCommandIntent | null {
  if (typeof value !== "object" || value === null) return null;
  const kind: unknown = Reflect.get(value, "kind");
  if (typeof kind !== "string") return null;
  if (kind === "update-epic-title") {
    const title: unknown = Reflect.get(value, "title");
    const updatedAt: unknown = Reflect.get(value, "updatedAt");
    return typeof title === "string" && typeof updatedAt === "number"
      ? { kind, title, updatedAt }
      : null;
  }
  return readArtifactIntent(value, kind);
}

export interface EpicWriteCommandSender {
  currentHostId(): string | null;
  send(
    commandId: string,
    intent: EpicWriteCommandIntent,
  ): Promise<{ readonly hostId: string }>;
}

export class EpicWriteCommandTransportUnavailableError extends Error {
  constructor() {
    super("No host requester is attached to this epic session");
    this.name = "EpicWriteCommandTransportUnavailableError";
  }
}

/**
 * A failure that was already classified, on the other side of the bridge.
 *
 * `Error` does not survive structured clone, so a write command sent from the
 * worker is dispatched by MAIN, which owns the requester and therefore owns
 * the classification. What comes back is the classifier's own union - never a
 * thrown object the worker would have to reconstruct - and the queue's contract
 * is `classifyFailure(error)`, so the union has to be carried back INTO a throw
 * to reach it. This is that carrier, and the first branch below is where it
 * comes out again.
 *
 * The alternative was widening `CommandQueueOptions` to accept a pre-classified
 * failure, which would change a SHARED contract for one caller's transport.
 */
export class RelayedWriteCommandFailureError extends Error {
  readonly failure: CommandSendFailure;

  constructor(failure: CommandSendFailure) {
    super(`Write command failed on the main thread: ${failure.kind}`);
    this.name = "RelayedWriteCommandFailureError";
    this.failure = failure;
  }
}

export function classifyEpicWriteCommandFailure(
  error: unknown,
): CommandSendFailure {
  // First, and it must stay first: this failure has already been through this
  // function on the other thread. Re-classifying it would reduce a precise
  // `rejected` with its host code to the catch-all `RPC_ERROR` below.
  if (error instanceof RelayedWriteCommandFailureError) return error.failure;
  if (
    error instanceof RetryableTransportError ||
    error instanceof StaleHostBindingAuthorityError ||
    error instanceof EpicWriteCommandTransportUnavailableError
  ) {
    // Whether the DIAL is what ran out, which is the only member of this
    // branch that is owed no wake-up. See `retryAfterMs` below.
    const dialExhausted = error instanceof RetryableTransportError;
    return {
      kind: "queued",
      reason: error instanceof Error ? error.message : String(error),
      boundedRetry: dialExhausted,
      // A self-timer for the dial failure ONLY, and the asymmetry is the whole
      // point: this field asks "will anything ever wake this command", and the
      // three members of the branch answer differently.
      //
      // The other two are owed an event. `send`'s first gate raises
      // `EpicWriteCommandTransportUnavailableError` on exactly the predicate
      // `drainWritePathsAfterReconnect` gates on - transport open, fresh root
      // snapshot for this cycle - so whatever clears it IS a `retryPending()`
      // caller; and a stale host binding is a transport change, which reaches
      // the same drain. A timer there would only race them. (The same error
      // also covers a missing requester or host id past that gate, which is a
      // state an open lane transport should not be in; it is not the case the
      // `null` is chosen for, and a timer would be no worse there.)
      //
      // A `RetryableTransportError` is the opposite, and that same gate is the
      // proof rather than an assumption: it can only be raised AFTER the gate
      // passed, so the lane transport is open and its snapshot is fresh -
      // nothing about the lane moved, and neither drain is owed. Unaries dial
      // their own socket per attempt (`createRetryingMessenger` retries "on a
      // fresh dial"), so this is a dial that kept failing underneath lanes that
      // stayed up. `pump` refuses to look past the FIFO head, so with no timer
      // this command and every later metadata write wait for a reconnect that
      // is never coming.
      //
      // Same shape as `E_IDEMPOTENCY_CACHE_SATURATED` below, reached from the
      // other side - there the transport answered, here it never dialled, and
      // in both the control stream stays open so no event is owed. It differs
      // in one way that matters: this one is `boundedRetry`, and it is the
      // first failure to be both. `releaseQueuedCommand` in the queue is what
      // keeps that safe, by checking the replay deadline on the TIMER's path
      // and not only on the drain's.
      retryAfterMs: dialExhausted ? COMMAND_DIAL_RETRY_BASE_MS : null,
    };
  }
  if (error instanceof HostTransportFailureError) {
    return { kind: "unknown-outcome", reason: error.message };
  }
  if (error instanceof HostRpcError) {
    if (error.code === "E_IDEMPOTENCY_CACHE_SATURATED") {
      // The host emitted this only before resolver dispatch. Keep the command
      // queued with its stable key: a retry is safe and may succeed once
      // replay capacity returns. Because the host proved it did not run, this
      // refusal must never arm the ambiguous-send deadline.
      //
      // AND SCHEDULE THAT RETRY, because nothing else will. "A later reconnect
      // drain" was the plan and there is no reconnect owed: this is an
      // ordinary unary answer over a control stream that stays open, so
      // neither `drainWritePathsAfterReconnect` nor the snapshot-landed path
      // ever fires. The command would sit in `blockedUntilRetry` for the life
      // of the session - and since `pump` only ever looks at the FIFO head,
      // every later metadata write would queue behind it with no Retry
      // affordance on any of them.
      return {
        kind: "queued",
        reason: error.message,
        boundedRetry: false,
        retryAfterMs: COMMAND_SATURATION_RETRY_BASE_MS,
      };
    }
    if (error.code === "E_IDEMPOTENCY_OUTCOME_UNKNOWN") {
      // The host retained the key but could not prove the original resolver's
      // result by its in-flight ceiling. Never auto-retry an ambiguous write;
      // the overlay's authoritative echo/TTL path owns reconciliation.
      return { kind: "unknown-outcome", reason: error.message };
    }
    return {
      kind: "rejected",
      resolution: {
        kind: "rejected",
        code: error.code,
        reason: error.message,
        retryable: false,
      },
    };
  }
  return {
    kind: "rejected",
    resolution: {
      kind: "rejected",
      code: "RPC_ERROR",
      reason: error instanceof Error ? error.message : String(error),
      retryable: false,
    },
  };
}
