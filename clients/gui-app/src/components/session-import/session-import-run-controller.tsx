import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  SessionImportRunClient,
  type SessionImportRunCallbacks,
  type SessionImportRunCompletePayload,
  type SessionImportRunProgressPayload,
  type SessionImportRunStartedPayload,
} from "@traycer-clients/shared/host-transport/session-import-run-client";
import {
  useStreamHostId,
  useWsStreamClient,
} from "@/lib/host/stream-runtime-context";
import { hostQueryKeys, sessionImportQueryKeys } from "@/lib/query-keys";
import {
  progressEntryFrom,
  useSessionImportRunStore,
} from "@/stores/session-import/session-import-run-store";
import { useImportedUnseenStore } from "@/stores/session-import/imported-unseen-store";
import {
  getSessionImportStartHandle,
  setSessionImportStartHandle,
  type SessionImportRunRequest,
} from "@/components/session-import/session-import-run-handle";

/**
 * Owns the single `sessionImport.run` subscription for the whole app.
 *
 * App-level rather than wizard-level on purpose: the user is invited to close
 * the wizard and carry on with the tour while the import runs, and a stream
 * owned by that wizard would detach the moment they did - leaving the Settings
 * entry and the reopened wizard with nothing to show but a stale snapshot.
 * Here it stays attached for the life of the window, and the store it feeds is
 * what every import surface reads.
 *
 * It also asks the host, whenever a stream client connects, whether a run is
 * already going. A window opened while the host is still importing - a
 * reload, a second window - would otherwise show an idle wizard over a live
 * run, and its Import button would attach to that run instead of starting the
 * user's own selection.
 */
export function SessionImportRunController(): null {
  const queryClient = useQueryClient();
  const wsStreamClient = useWsStreamClient();
  // The host the run will actually execute on is the one this stream dials, so
  // its name has to come off the same binding as the client - a host swap
  // between the two reads would invalidate one machine's queries for a run that
  // happened on another. See `StreamRuntimeBinding.hostId`.
  const streamHostId = useStreamHostId();
  const clientRef = useRef<SessionImportRunClient | null>(null);
  // The mount-time probe while it is still waiting for the host's answer.
  // Cleared the moment it attaches (it is the run's subscription then) or
  // closes, so `start` can tell "a run is going" from "we are still asking".
  const waitingProbeRef = useRef<SessionImportRunClient | null>(null);

  const closeClient = useCallback(() => {
    const client = clientRef.current;
    if (client !== null) {
      clientRef.current = null;
      if (waitingProbeRef.current === client) waitingProbeRef.current = null;
      client.close();
    }
  }, []);

  // The frames every subscription feeds the store from, whether it started
  // the run or found one going. `hostIdAtStart` is captured by the caller: the
  // run outlives this binding, and by the time it completes the app may be
  // pointed at a different host.
  const runCallbacks = useCallback(
    (hostIdAtStart: string | null): SessionImportRunCallbacks => ({
      onStarted: (payload: SessionImportRunStartedPayload) => {
        useSessionImportRunStore.getState().applyStarted({
          runId: payload.runId,
          total: payload.total,
          attached: payload.attached,
        });
      },
      onProgress: (payload: SessionImportRunProgressPayload) => {
        const entry = progressEntryFrom(payload);
        useSessionImportRunStore.getState().applyProgress(entry);
        // The task list's unread dot: each landed task is unseen until its
        // epic is first opened.
        if (entry.outcome.kind === "imported") {
          useImportedUnseenStore
            .getState()
            .markImported(entry.outcome.epicId, entry.harness);
        }
      },
      onComplete: (payload: SessionImportRunCompletePayload) => {
        useSessionImportRunStore.getState().applyComplete({
          runId: payload.runId,
          counts: payload.counts,
        });
        // Imported sessions are real epics and chats; the task list and the
        // Settings entry's `lastCompleted` are both stale the instant the
        // run lands.
        if (hostIdAtStart !== null) {
          void queryClient.invalidateQueries({
            queryKey: sessionImportQueryKeys.status(hostIdAtStart),
          });
          void queryClient.invalidateQueries({
            queryKey: hostQueryKeys.scope(hostIdAtStart),
          });
        }
        closeClient();
      },
      onConnectionStatus: (_status, reason) => {
        if (reason === null) return;
        if (clientRef.current === null) return;
        useSessionImportRunStore.getState().applyError();
        closeClient();
      },
    }),
    [closeClient, queryClient],
  );

  const start = useCallback(
    (request: SessionImportRunRequest) => {
      if (wsStreamClient === null) return;
      // One run at a time is the contract; a second subscribe would attach to
      // the first and silently drop this submission's selections. A probe
      // still waiting for its answer is not a run, though: dropping the
      // user's click for it would lose the submission with nothing on screen
      // to say so. Close it and subscribe with the selections - if a run WAS
      // in flight, this subscribe attaches to it exactly as the probe would.
      if (clientRef.current !== null) {
        if (clientRef.current !== waitingProbeRef.current) return;
        closeClient();
      }
      if (request.selections.length === 0) return;

      useSessionImportRunStore.getState().markStarting(request.titles);
      clientRef.current = new SessionImportRunClient({
        wsStreamClient,
        selections: request.selections,
        callbacks: runCallbacks(streamHostId),
      });
    },
    [closeClient, runCallbacks, streamHostId, wsStreamClient],
  );

  // Subscribing with no selections is the host's "attach to whatever is
  // running" form: a run in flight replays from the start, and an idle host
  // answers with an empty run instead. The store is touched only in the first
  // case - the probe closes on the empty answer before its `complete` frame
  // could read as "nothing was imported".
  useEffect(() => {
    if (wsStreamClient === null) return;
    if (clientRef.current !== null) return;
    if (useSessionImportRunStore.getState().status !== "idle") return;

    const callbacks = runCallbacks(streamHostId);
    let attached = false;
    const probe = new SessionImportRunClient({
      wsStreamClient,
      selections: [],
      callbacks: {
        ...callbacks,
        onStarted: (payload) => {
          if (!payload.attached) {
            closeClient();
            return;
          }
          attached = true;
          waitingProbeRef.current = null;
          callbacks.onStarted(payload);
        },
      },
    });
    clientRef.current = probe;
    waitingProbeRef.current = probe;
    return () => {
      // A probe still waiting for its answer when the client is replaced is
      // asking a connection that is gone; one that attached is the run's
      // subscription now and stays.
      if (!attached && clientRef.current === probe) closeClient();
    };
  }, [closeClient, runCallbacks, streamHostId, wsStreamClient]);

  useEffect(() => {
    setSessionImportStartHandle({ start });
    return () => {
      if (getSessionImportStartHandle()?.start === start) {
        setSessionImportStartHandle(null);
      }
    };
  }, [start]);

  useEffect(
    () => () => {
      closeClient();
    },
    [closeClient],
  );

  return null;
}
