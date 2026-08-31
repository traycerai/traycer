import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  SessionImportRunClient,
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

  const closeClient = useCallback(() => {
    const client = clientRef.current;
    if (client !== null) {
      clientRef.current = null;
      client.close();
    }
  }, []);

  const start = useCallback(
    (request: SessionImportRunRequest) => {
      if (wsStreamClient === null) return;
      // One run at a time is the contract; a second subscribe would attach to
      // the first and silently drop this submission's selections.
      if (clientRef.current !== null) return;
      if (request.selections.length === 0) return;

      // Captured at start: the run outlives this binding, and by the time it
      // completes the app may be pointed at a different host.
      const hostIdAtStart = streamHostId;
      useSessionImportRunStore.getState().markStarting(request.titles);

      clientRef.current = new SessionImportRunClient({
        wsStreamClient,
        selections: request.selections,
        callbacks: {
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
        },
      });
    },
    [closeClient, queryClient, streamHostId, wsStreamClient],
  );

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
