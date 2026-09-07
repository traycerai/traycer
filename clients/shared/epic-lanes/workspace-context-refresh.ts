/**
 * Fetch at tab open; refetch on reconnect and on every control-lane migration or permission frame. Triggers coalesce: at most one in flight, last trigger always followed by a later fetch.
 * Completion is an authority-epoch change, not a frame; noteAuthorityEpochChanged is that trigger.
 */
import type {
  ControlEvent,
  RuntimeEnvironment,
} from "@traycer-clients/shared/replica-runtime";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { EarlyMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";

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
  /** Injected so this policy owns when to read, not how. */
  readonly fetch: (epicId: string) => Promise<EarlyMetaEpic>;
  readonly onContext: (
    context: EarlyMetaEpic,
    cause: WorkspaceContextRefreshCause,
  ) => void;
  /** Reported, never latched. Degrade is the composition's call. */
  readonly onError: (
    error: unknown,
    cause: WorkspaceContextRefreshCause,
  ) => void;
  readonly isDisposed: () => boolean;
}

export interface WorkspaceContextRefreshPolicy {
  /** The read at tab open. Idempotent: a second call is ignored. */
  start(): void;
  /** Only a return to `open` after leaving it refetches; the first `open` is tab open. */
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
  /** Hold the cause, not a boolean, so a trailing fetch's provenance stays honest. */
  let pendingCause: WorkspaceContextRefreshCause | null = null;
  /** Return to open counts as reconnect only if the transport left open. */
  let transportLeftOpen = false;
  /**
   * `initial` is the only trigger with no successor. Exactly one retry after an observed failure; retrying on "no context yet" doubles the cold open.
   * `everFetched` tracks the fetch, not delivery.
   */
  let everFetched = false;
  let initialReadFailed = false;
  let initialRetryUsed = false;
  let transportEverOpened = false;

  function alive(): boolean {
    return !disposed && !isDisposed();
  }

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

  function retryInitialReadIfOwed(): void {
    if (everFetched || initialRetryUsed) return;
    if (!initialReadFailed || !transportEverOpened) return;
    initialRetryUsed = true;
    // Reported as `initial`: the same first read, arriving later.
    run("initial");
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
          everFetched = true;
          if (!alive()) return;
          // Deliver in its own continuation so a consumer throw is not a fetch failure.
          deliver(context, cause);
        },
        (error: unknown) => {
          if (!everFetched) initialReadFailed = true;
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
        // A queued trigger subsumes the retry and leaves initialRetryUsed unspent.
        if (next !== null) {
          run(next);
          return;
        }
        // After `inFlight` is cleared, never from inside the rejection handler: running there would route the retry through `pendingCause`, where the next arriving trigger would overwrite it.
        retryInitialReadIfOwed();
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
      transportEverOpened = true;
      if (!transportLeftOpen) {
        // First `open` is tab open unless that read failed; then this is the only retry moment.
        retryInitialReadIfOwed();
        return;
      }
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
      // cloud-sync-status, aggregate-dirty, and epic-deleted do not change workspace context; do not refetch.
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
