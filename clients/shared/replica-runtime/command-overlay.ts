/**
 * The write path as an overlay on the read model.
 *
 * Mutations do not write into the replica. They are issued as commands with
 * client-generated ids, held in a queue that survives a disconnect, and
 * PROJECTED over the authoritative rows until the authority answers. The
 * replica stays a pure function of what the authority has said, which is what
 * makes a rejection recoverable instead of a rollback.
 *
 * Two things this interface refuses to let a caller do:
 *
 * 1. **Silently roll back.** A rejected or superseded command keeps its intent
 *    and gains an authoritative reason. Snapping the row back to the server
 *    value with no trace is the behaviour being replaced.
 * 2. **Claim epic-global durability.** A commit is HOST-committed. Shared epics
 *    have several participants whose hosts write the same epic, and until
 *    record replication exists the inter-host plane is CRDT last-writer-wins
 *    through cloud rooms - so a remote host's concurrent write can supersede a
 *    locally committed command. That is what `"superseded"` is for, and why the
 *    committed arm names the host that committed it.
 */
import type { RuntimeEnvironment, RuntimeTimer } from "./runtime-environment";

/**
 * Client-generated, and generated BEFORE the first send.
 *
 * It is the dedupe key: a retry after a reconnect carries the same id, so the
 * authority can recognise the second delivery of a command it already applied.
 * A server-assigned id cannot do this, because the case that needs deduping is
 * exactly the one where the client never learned the id.
 */
export type CommandId = string;

/**
 * Injected rather than calling `crypto.randomUUID()` inline: the runtime is
 * worker-portable and must not assume which globals its host provides, and a
 * deterministic factory is what lets a replay harness assert on ids at all.
 */
export interface CommandIdFactory {
  next(): CommandId;
}

export type CommandState =
  /** Issued, unanswered. The overlay is applied. */
  | "pending"
  /**
   * The serving host applied it. Host-terminal, but not globally terminal: a
   * later cross-host merge may still move this record to `superseded`.
   */
  | "committed"
  /** The authority refused it. Terminal; the intent is retained. */
  | "rejected"
  /**
   * Another writer's change won. Terminal; the intent is retained.
   *
   * Not a synonym for rejected: nothing was wrong with the command, and the
   * user's next action is usually to reapply it rather than to correct it.
   */
  | "superseded";

export type CommandResolution =
  | {
      readonly kind: "committed";
      /**
       * Which host committed it. Present because the commit is that host's
       * statement, not the epic's - UX copy derived from this must say
       * host-committed and must never imply epic-global durability.
       */
      readonly hostId: string;
      /** `null` for released unary contracts that do not return a revision. */
      readonly entityVersion: number | null;
    }
  | {
      readonly kind: "rejected";
      /** Machine-readable, from the authority. */
      readonly code: string;
      /** Human-readable, from the authority. Never synthesised client-side. */
      readonly reason: string;
      /**
       * Whether reissuing the same intent could succeed. A precondition failure
       * is retryable after a refresh; a permission denial is not.
       */
      readonly retryable: boolean;
    }
  | {
      readonly kind: "superseded";
      readonly observedAtMs: number;
      /**
       * How the supersession was detected - a CRDT merge from a remote host, a
       * newer row revision on the record lane. Recorded because the two have
       * different explanations for the user.
       */
      readonly via: string;
    };

export type CommandDeliveryState =
  /** Waiting for the first send or an explicit reconnect drain. */
  | "queued"
  /** One transport attempt currently owns the command. */
  | "sending"
  /**
   * The request may have reached an unnegotiated host. Never auto-retried: the
   * overlay waits for an echo/TTL verdict until the user explicitly retries.
   */
  | "unknown-outcome"
  /** The command has a resolution. */
  | "settled";

export interface CommandRecord<TIntent> {
  readonly commandId: CommandId;
  /**
   * What the user asked for, retained verbatim through every terminal state.
   * This is the field that makes "never silent rollback" true: a rejected
   * command still knows what it was trying to do, so it can be shown, retried,
   * or copied out.
   */
  readonly intent: TIntent;
  readonly state: CommandState;
  readonly delivery: CommandDeliveryState;
  readonly issuedAtMs: number;
  /** Send attempts so far. >1 means it survived at least one disconnect. */
  readonly attempts: number;
  /**
   * The revision the caller believes it is editing, or `null` for a blind
   * write. Guards against the SERVING HOST's revision only - it says nothing
   * about a concurrent remote host, which is what `"superseded"` covers.
   */
  readonly expectedEntityVersion: number | null;
  /** Non-null exactly when {@link state} is not `"pending"`. */
  readonly resolution: CommandResolution | null;
}

export interface CommandEnqueueRequest<TIntent> {
  readonly intent: TIntent;
  readonly expectedEntityVersion: number | null;
}

export interface CommandQueue<TIntent> {
  /** Mints an id, records the command as pending, and attempts a send. */
  enqueue(
    request: CommandEnqueueRequest<TIntent>,
  ): CommandRecord<TIntent> | null;

  /**
   * Re-send everything still pending, in issue order.
   *
   * Order matters: two renames of one row applied out of order leave the wrong
   * title. Dedupe by {@link CommandId} on the authority side is what makes
   * re-sending safe.
   */
  retryPending(): void;

  /** Explicit user retry, including an `unknown-outcome` command. */
  retry(commandId: CommandId): void;

  /** Record the authority's answer. Idempotent per command id. */
  resolve(commandId: CommandId, resolution: CommandResolution): void;

  /**
   * Drop a terminal command the user has acknowledged.
   *
   * Only terminal commands may be discarded - discarding a pending one would
   * remove the overlay while the write is still in flight, which is a silent
   * rollback wearing a different hat.
   */
  discard(commandId: CommandId): void;

  /** Every command not yet discarded, in issue order. */
  list(): readonly CommandRecord<TIntent>[];

  /** Pending only - leg (iv) of a sync indicator's inputs. */
  pending(): readonly CommandRecord<TIntent>[];

  /**
   * Terminal-but-unacknowledged. A green sync indicator must never hide a
   * non-empty answer here.
   */
  unacknowledged(): readonly CommandRecord<TIntent>[];

  subscribe(listener: () => void): () => void;

  /** Terminal. Pending commands are dropped; the caller has already decided. */
  dispose(): void;
}

/**
 * Projects pending commands over an authoritative projection.
 *
 * Pure and total: same base plus same commands gives the same output, with no
 * hidden state. That is what lets the overlay be reapplied on every projection
 * instead of being maintained incrementally beside one - the incremental
 * version has to agree with the full one, and nothing keeps two
 * implementations of the same rule in agreement.
 *
 * Applied to the rows components READ, and before any derived structure is
 * built from them, so a pending reparent restructures the tree for free rather
 * than needing the tree patched a second time.
 */
export interface CommandOverlay<TProjection, TIntent> {
  apply(
    base: TProjection,
    commands: readonly CommandRecord<TIntent>[],
  ): TProjection;
}

export type CommandSendFailure =
  | {
      readonly kind: "queued";
      readonly reason: string;
      /**
       * True when safety depends on the host retaining a negotiated replay
       * key. Pure pre-send failures may wait offline without a deadline.
       */
      readonly boundedRetry: boolean;
      /**
       * Re-drive this command on the queue's OWN timer after at least this
       * many milliseconds, or `null` to wait for an external drain.
       *
       * `null` is right for a queued failure that a reconnect is owed for -
       * a dead transport, a stale host binding - because `retryPending()`
       * fires on the events that resolve those, and a self-timer would only
       * race them.
       *
       * It is wrong for a failure the transport ANSWERED. A queued command
       * sits in `blockedUntilRetry` and `pump` refuses to look past the FIFO
       * head, so a refusal that leaves the control stream open owes no event
       * at all: the command waits forever and every later write waits behind
       * it. That is the shape `E_IDEMPOTENCY_CACHE_SATURATED` has, and it is
       * why this field exists rather than a second call to `retryPending`.
       */
      readonly retryAfterMs: number | null;
    }
  | { readonly kind: "unknown-outcome"; readonly reason: string }
  | { readonly kind: "rejected"; readonly resolution: CommandResolution };

/**
 * The longest automatic reconnect retry after a keyed attempt becomes
 * ambiguous. The host retains outcomes for twice this interval; after it, the
 * queue surfaces `unknown-outcome` and waits for echo/TTL or an explicit user
 * retry instead of assuming the key is still resident.
 */
export const COMMAND_AUTO_RETRY_WINDOW_MS = 5 * 60 * 1_000;

/**
 * Ceiling for a self-scheduled re-drive.
 *
 * The delay a failure asks for is doubled per attempt so a host that stays
 * refusing is not hammered, and clamped here so a long-lived saturation still
 * clears within a interval a person would call "it recovered on its own"
 * rather than one that reads as a hang.
 */
export const COMMAND_SELF_RETRY_MAX_DELAY_MS = 30 * 1_000;

export interface CommandQueueOptions<TIntent> {
  readonly environment: RuntimeEnvironment;
  readonly idFactory: CommandIdFactory;
  /** One attempt. The queue serializes calls in issue order. */
  readonly send: (
    command: CommandRecord<TIntent>,
  ) => Promise<CommandResolution>;
  readonly classifyFailure: (error: unknown) => CommandSendFailure;
  /** Validates against the current authoritative-plus-overlay projection. */
  readonly accept: (request: CommandEnqueueRequest<TIntent>) => boolean;
  /** Applies the optimistic overlay after the id exists and before send. */
  readonly onEnqueued: (command: CommandRecord<TIntent>) => boolean;
  /** Arms echo/TTL reconciliation after an ambiguous unkeyed delivery. */
  readonly onUnknownOutcome: (command: CommandRecord<TIntent>) => void;
  /** Runs exactly once for each accepted lifecycle transition. */
  readonly onResolved: (command: CommandRecord<TIntent>) => void;
}

/** Concrete minimal FIFO used by the epic write path. */
export function createCommandQueue<TIntent>(
  options: CommandQueueOptions<TIntent>,
): CommandQueue<TIntent> {
  let disposed = false;
  let sendingCommandId: CommandId | null = null;
  const records: CommandRecord<TIntent>[] = [];
  const blockedUntilRetry = new Set<CommandId>();
  const retryDeadlineByCommandId = new Map<CommandId, number>();
  // Self-scheduled re-drives, one per command at most. Held so every path that
  // ends a command's wait - resolve, retry, discard, dispose, an external
  // `retryPending` - can cancel it: a timer that outlives its command would
  // fire into a `pump()` that has nothing to do, and one that outlives the
  // QUEUE would fire after dispose.
  const selfRetryTimers = new Map<CommandId, RuntimeTimer>();
  const listeners = new Set<() => void>();

  function cancelSelfRetry(commandId: CommandId): void {
    selfRetryTimers.get(commandId)?.cancel();
    selfRetryTimers.delete(commandId);
  }

  /**
   * Unblock `commandId` after a backoff and let the pump take it again.
   *
   * Re-checked at fire time rather than trusted: the scheduler contract allows
   * firing late, and by then the command may have been resolved, discarded or
   * already re-driven by a reconnect.
   */
  function scheduleSelfRetry(
    commandId: CommandId,
    baseDelayMs: number,
    attempts: number,
  ): void {
    cancelSelfRetry(commandId);
    // Attempt 1 waits the base delay; each further refusal doubles it. The
    // exponent is clamped as well as the product, so a command that somehow
    // accumulates many attempts cannot overflow into a non-finite delay.
    const growth = 2 ** Math.min(Math.max(attempts - 1, 0), 16);
    const delayMs = Math.min(
      baseDelayMs * growth,
      COMMAND_SELF_RETRY_MAX_DELAY_MS,
    );
    const timer = options.environment.scheduler.schedule(delayMs, () => {
      selfRetryTimers.delete(commandId);
      if (disposed) return;
      const record = records.find((entry) => entry.commandId === commandId);
      if (
        record === undefined ||
        record.state !== "pending" ||
        record.delivery !== "queued"
      ) {
        return;
      }
      blockedUntilRetry.delete(commandId);
      pump();
    });
    selfRetryTimers.set(commandId, timer);
  }

  function publish(): void {
    for (const listener of [...listeners]) listener();
  }

  function replace(
    commandId: CommandId,
    update: (record: CommandRecord<TIntent>) => CommandRecord<TIntent>,
  ): CommandRecord<TIntent> | null {
    const index = records.findIndex((record) => record.commandId === commandId);
    if (index < 0) return null;
    const next = update(records[index]);
    records[index] = next;
    publish();
    return next;
  }

  function resolve(commandId: CommandId, resolution: CommandResolution): void {
    const index = records.findIndex((record) => record.commandId === commandId);
    if (index < 0) return;
    const current = records[index];
    const accepted =
      current.state === "pending" ||
      (current.state === "committed" && resolution.kind === "superseded");
    if (!accepted) return;
    const next: CommandRecord<TIntent> = {
      ...current,
      state: resolution.kind,
      delivery: "settled",
      resolution,
    };
    records[index] = next;
    blockedUntilRetry.delete(commandId);
    retryDeadlineByCommandId.delete(commandId);
    cancelSelfRetry(commandId);
    publish();
    options.onResolved(next);
    pump();
  }

  function pump(): void {
    if (disposed || sendingCommandId !== null) return;
    const command = records.find((record) => record.state === "pending");
    if (
      command === undefined ||
      command.delivery !== "queued" ||
      blockedUntilRetry.has(command.commandId)
    ) {
      return;
    }
    sendingCommandId = command.commandId;
    const sending = replace(command.commandId, (current) => ({
      ...current,
      delivery: "sending",
      attempts: current.attempts + 1,
    }));
    if (sending === null) {
      sendingCommandId = null;
      return;
    }
    void options
      .send(sending)
      .then(
        (resolution) => {
          if (!disposed) resolve(sending.commandId, resolution);
        },
        (error: unknown) => {
          if (disposed) return;
          const failure = options.classifyFailure(error);
          if (failure.kind === "rejected") {
            resolve(sending.commandId, failure.resolution);
            return;
          }
          const uncertain = replace(sending.commandId, (current) => {
            if (current.state !== "pending") return current;
            return {
              ...current,
              delivery:
                failure.kind === "unknown-outcome"
                  ? "unknown-outcome"
                  : "queued",
            };
          });
          if (
            failure.kind === "unknown-outcome" &&
            uncertain?.state === "pending" &&
            uncertain.delivery === "unknown-outcome"
          ) {
            options.onUnknownOutcome(uncertain);
          }
          if (failure.kind === "queued") {
            blockedUntilRetry.add(sending.commandId);
            // Armed BEFORE the deadline bookkeeping below, and independent of
            // it: `boundedRetry` answers "may this wait offline without a
            // safety deadline", which is a different question from "will
            // anything ever wake it".
            if (failure.retryAfterMs !== null) {
              scheduleSelfRetry(
                sending.commandId,
                failure.retryAfterMs,
                sending.attempts,
              );
            }
            // The FIRST ambiguous keyed attempt starts the safety window. Never
            // slide or clear that deadline after another reconnect attempt: a
            // sequence of four-minute failures must not keep the command alive
            // past the host cache's ten-minute retention and eventually execute
            // it again after the dedupe entry expires. A later pure pre-send
            // failure is still part of the same bounded replay episode.
            if (
              failure.boundedRetry &&
              !retryDeadlineByCommandId.has(sending.commandId)
            ) {
              retryDeadlineByCommandId.set(
                sending.commandId,
                options.environment.clock.now() + COMMAND_AUTO_RETRY_WINDOW_MS,
              );
            }
          }
        },
      )
      .finally(() => {
        if (sendingCommandId === sending.commandId) sendingCommandId = null;
        pump();
      });
  }

  return {
    enqueue(request) {
      if (!options.accept(request)) return null;
      const record: CommandRecord<TIntent> = {
        commandId: options.idFactory.next(),
        intent: request.intent,
        state: "pending",
        delivery: "queued",
        issuedAtMs: options.environment.clock.now(),
        attempts: 0,
        expectedEntityVersion: request.expectedEntityVersion,
        resolution: null,
      };
      records.push(record);
      if (!options.onEnqueued(record)) {
        records.pop();
        return null;
      }
      publish();
      pump();
      return record;
    },

    retryPending(): void {
      for (const record of records) {
        if (record.state === "pending" && record.delivery === "queued") {
          const retryDeadline = retryDeadlineByCommandId.get(record.commandId);
          if (
            retryDeadline !== undefined &&
            retryDeadline <= options.environment.clock.now()
          ) {
            retryDeadlineByCommandId.delete(record.commandId);
            blockedUntilRetry.delete(record.commandId);
            // This arm leaves the loop before the cancel below, and a command
            // that just became `unknown-outcome` has no queued retry left to
            // drive. The timer would find the wrong delivery and no-op, but it
            // would stay armed until it fired.
            cancelSelfRetry(record.commandId);
            const uncertain = replace(record.commandId, (current) => ({
              ...current,
              delivery: "unknown-outcome",
            }));
            if (uncertain !== null) options.onUnknownOutcome(uncertain);
            continue;
          }
          blockedUntilRetry.delete(record.commandId);
          // The external drain supersedes any timer this command was waiting
          // on. Leaving it armed would be harmless - it re-checks and finds
          // nothing blocked - but it would also re-arm on the NEXT refusal
          // from a stale attempt count, so the backoff is reset with the wait.
          cancelSelfRetry(record.commandId);
        }
      }
      pump();
    },

    retry(commandId): void {
      replace(commandId, (current) => {
        if (current.state !== "pending") return current;
        return { ...current, delivery: "queued" };
      });
      blockedUntilRetry.delete(commandId);
      retryDeadlineByCommandId.delete(commandId);
      cancelSelfRetry(commandId);
      pump();
    },

    resolve,

    discard(commandId): void {
      const index = records.findIndex(
        (record) => record.commandId === commandId,
      );
      if (index < 0 || records[index].state === "pending") return;
      records.splice(index, 1);
      blockedUntilRetry.delete(commandId);
      retryDeadlineByCommandId.delete(commandId);
      cancelSelfRetry(commandId);
      publish();
    },

    list: () => records.slice(),
    pending: () => records.filter((record) => record.state === "pending"),
    unacknowledged: () =>
      records.filter((record) => record.state !== "pending"),

    subscribe(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      records.splice(0, records.length);
      blockedUntilRetry.clear();
      retryDeadlineByCommandId.clear();
      for (const timer of selfRetryTimers.values()) timer.cancel();
      selfRetryTimers.clear();
      listeners.clear();
    },
  };
}
