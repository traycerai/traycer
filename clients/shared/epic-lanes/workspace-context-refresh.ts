/**
 * The `epic.getWorkspaceContext@1.0` fetch-and-REFETCH policy.
 *
 * The read itself is a one-line unary. This module exists for the other half of
 * its contract, which is the half a naive port silently drops.
 *
 * ## What is easy to lose
 *
 * On the monolith the workspace context was `earlyMeta`, a FRAME - and it was
 * RE-EMITTED, not one-shot: the host resent it on reconnect and whenever a
 * migration or permission signal changed what it said. Turning it into a unary
 * that is called once at tab open is a behaviour regression whose symptom is a
 * stale repo chip and a stale permission display that nothing ever corrects,
 * on a surface where nothing looks broken. So the caller's obligation is part
 * of the contract: fetch at tab open, and REFETCH on reconnect and on every
 * control-lane migration or permission frame.
 *
 * The control lane is what tells a client its workspace context may have moved;
 * this read is how it finds out what to.
 *
 * ## Coalescing, and why it is not optional
 *
 * Taken literally, "every migration frame" is one fetch per `migrationProgress`
 * - dozens during an upload, against a host that is busy migrating, on exactly
 * the link least able to absorb a stampede. That is the `commentThreadsChanged`
 * refetch-storm the records lane was redesigned to avoid, reintroduced one
 * method over.
 *
 * So triggers COALESCE rather than queue: at most one request is in flight, and
 * a trigger that arrives while one is running sets a re-run flag instead of
 * starting a second. The guarantee that buys is the one that matters - the LAST
 * trigger is always followed by a fetch that started after it - while the cost
 * of a burst is two requests rather than N. Dropping the trailing flag instead
 * would be the cheaper implementation and the wrong one: the final progress
 * frame is the one that precedes completion, and answering the state before it
 * is how a stale context survives the whole migration.
 *
 * ## Completion is an epoch change, not a frame
 *
 * There is no "migration completed" frame anywhere in this design - completion
 * IS the authority epoch changing - so a policy that watched only
 * {@link ControlEvent} would refetch throughout a migration and never once
 * after it finished, which is the single moment the context is most likely to
 * have moved. {@link WorkspaceContextRefreshPolicy.noteAuthorityEpochChanged}
 * is that trigger, and it is separate rather than inferred because nothing in
 * the control event union carries an epoch.
 */
import type {
  ControlEvent,
  RuntimeEnvironment,
} from "@traycer-clients/shared/replica-runtime";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { EarlyMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";

/** Why a fetch was issued. Carried to the consumer for logs and telemetry. */
export type WorkspaceContextRefreshCause =
  /** The first read, at tab open. */
  | "initial"
  /** The transport came back after a drop. */
  | "reconnect"
  /** A control-lane permission frame. */
  | "permission"
  /** A control-lane migration frame. */
  | "migration"
  /** The authority epoch moved - a replacement, or a migration completing. */
  | "authority-epoch-changed";

export interface WorkspaceContextRefreshSources {
  readonly epicId: string;
  readonly environment: RuntimeEnvironment;
  /**
   * Issues the unary. Injected rather than taking a requester, so this policy
   * owns WHEN to read and nothing about how: the transport's own request
   * options are the caller's business and can change without touching the
   * refresh contract.
   */
  readonly fetch: (epicId: string) => Promise<EarlyMetaEpic>;
  readonly onContext: (
    context: EarlyMetaEpic,
    cause: WorkspaceContextRefreshCause,
  ) => void;
  /**
   * A failed read. Reported, never latched: a host that does not serve this
   * method is a host still serving `epic.subscribe@1`, whose `earlyMeta` frame
   * IS this payload, so the degrade is the legacy adapter rather than a blank
   * surface - and deciding that is the composition's call, not this policy's.
   */
  readonly onError: (
    error: unknown,
    cause: WorkspaceContextRefreshCause,
  ) => void;
  readonly isDisposed: () => boolean;
}

export interface WorkspaceContextRefreshPolicy {
  /** The read at tab open. Idempotent: a second call is ignored. */
  start(): void;
  /**
   * Fold a transport transition. Only a return to `"open"` after the transport
   * had left it refetches - the first `"open"` of a session is the tab opening,
   * which {@link start} already covered, and refetching there would double
   * every cold open.
   */
  noteTransportStatus(status: StreamConnectionStatus): void;
  /** Fold a control-lane frame. Permission and migration frames refetch. */
  noteControlEvent(event: ControlEvent): void;
  /** The epoch moved: a replica replacement, or a migration completing. */
  noteAuthorityEpochChanged(): void;
  /** Terminal. Later triggers are ignored and an in-flight answer is dropped. */
  dispose(): void;
}

export function createWorkspaceContextRefreshPolicy(
  sources: WorkspaceContextRefreshSources,
): WorkspaceContextRefreshPolicy {
  const { epicId, environment, fetch, onContext, onError, isDisposed } =
    sources;

  let started = false;
  let disposed = false;
  let inFlight = false;
  /**
   * The cause of a trigger that arrived while a fetch was running, or `null`.
   * Holding the CAUSE rather than a boolean keeps the trailing fetch's
   * provenance honest - a reconnect that lands mid-migration is reported as the
   * reconnect it was.
   */
  let pendingCause: WorkspaceContextRefreshCause | null = null;
  /**
   * Whether the transport has been observed away from `"open"`. The return to
   * open only counts as a reconnect if there was something to come back from.
   */
  let transportLeftOpen = false;

  function alive(): boolean {
    return !disposed && !isDisposed();
  }

  /**
   * Hand the context to the consumer, keeping its failures out of the fetch's
   * error channel.
   *
   * A throw here is logged and swallowed rather than rethrown: this runs in a
   * detached promise continuation, so rethrowing would surface as an unhandled
   * rejection with no stack back to the trigger, and would also skip the
   * `finally` that clears the in-flight flag - wedging every later refresh.
   */
  function deliver(
    context: EarlyMetaEpic,
    cause: WorkspaceContextRefreshCause,
  ): void {
    try {
      onContext(context, cause);
    } catch {
      environment.logger.warn(
        "epic.getWorkspaceContext consumer threw on delivery",
        { epicId, cause },
      );
    }
  }

  function run(cause: WorkspaceContextRefreshCause): void {
    if (!alive()) return;
    if (inFlight) {
      pendingCause = cause;
      return;
    }
    inFlight = true;
    void fetch(epicId)
      .then(
        (context) => {
          if (!alive()) return;
          // Delivered in its OWN continuation, not inside the `then` whose
          // rejection handler is `onError`.
          //
          // Chaining `.then(deliver).catch(onError)` reports a consumer's own
          // exception as a fetch failure, and the two are different facts with
          // different remedies: a failed READ is retried and may mean the host
          // does not serve this method, while a failed DELIVERY means the read
          // succeeded and the consumer is broken. Conflating them would make a
          // renderer bug look like an unreachable host - and, worse, would let
          // a consumer that throws every time masquerade as a permanently
          // degraded connection.
          deliver(context, cause);
        },
        (error: unknown) => {
          if (!alive()) return;
          environment.logger.warn("epic.getWorkspaceContext refresh failed", {
            epicId,
            cause,
          });
          onError(error, cause);
        },
      )
      .finally(() => {
        inFlight = false;
        const next = pendingCause;
        pendingCause = null;
        if (next === null) return;
        run(next);
      });
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      run("initial");
    },

    noteTransportStatus(status: StreamConnectionStatus): void {
      if (status !== "open") {
        transportLeftOpen = true;
        return;
      }
      if (!transportLeftOpen) return;
      transportLeftOpen = false;
      run("reconnect");
    },

    noteControlEvent(event: ControlEvent): void {
      if (event.kind === "permission-changed") {
        run("permission");
        return;
      }
      if (event.kind === "migration") {
        run("migration");
      }
      // `cloud-sync-status`, `aggregate-dirty` and `epic-deleted` deliberately
      // do NOT refetch. None of them changes what the workspace context says -
      // repos, workspace folders, repo mapping, `epicLight`, the role - and
      // dirtiness in particular flips often enough that reading on it would
      // turn an idle epic into a poll.
    },

    noteAuthorityEpochChanged(): void {
      run("authority-epoch-changed");
    },

    dispose(): void {
      disposed = true;
      pendingCause = null;
    },
  };
}
