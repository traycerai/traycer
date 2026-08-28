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
import type { RuntimeEnvironment } from "./runtime-environment";

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
  /** The serving host applied it. Terminal, and host-scoped. */
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
      readonly entityVersion: number;
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
  enqueue(request: CommandEnqueueRequest<TIntent>): CommandRecord<TIntent>;

  /**
   * Re-send everything still pending, in issue order.
   *
   * Order matters: two renames of one row applied out of order leave the wrong
   * title. Dedupe by {@link CommandId} on the authority side is what makes
   * re-sending safe.
   */
  retryPending(): void;

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

export interface CommandQueueOptions {
  readonly environment: RuntimeEnvironment;
  readonly idFactory: CommandIdFactory;
}
