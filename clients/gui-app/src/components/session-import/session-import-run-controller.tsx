import { useCallback, useEffect, useReducer, useRef } from "react";
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
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  getSessionImportStartHandle,
  setSessionImportStartHandle,
  type SessionImportRunRequest,
  type SessionImportRunTarget,
} from "@/components/session-import/session-import-run-handle";

/**
 * Owns the `sessionImport.run` subscriptions for the whole app - ONE PER HOST.
 *
 * App-level rather than wizard-level on purpose: the user is invited to close
 * the wizard and carry on with the tour while the import runs, and a stream
 * owned by that wizard would detach the moment they did - leaving the Settings
 * entry and the reopened wizard with nothing to show but a stale snapshot.
 * Here it stays attached for the life of the window, and the store it feeds is
 * what every import surface reads.
 *
 * "One run at a time" is still the contract, but it is the HOST's contract, so
 * it holds per host: a second start for a host that is already importing is
 * refused, while another machine can start one of its own. The target travels
 * with the request (`SessionImportRunTarget`) rather than being read from this
 * component's ambient binding, so a run started from a host-scoped panel runs
 * on the host that panel is showing.
 *
 * It also asks the host, whenever the AMBIENT stream client connects, whether
 * a run is already going. A window opened while the host is still importing -
 * a reload, a second window - would otherwise show an idle wizard over a live
 * run, and its Import button would attach to that run instead of starting the
 * user's own selection. Only the ambient host is probed: a scoped host is
 * asked about by the surface that opens it, and probing every host the window
 * could reach is a fan-out nothing has asked for.
 */
export function SessionImportRunController(): null {
  const queryClient = useQueryClient();
  const ambientStreamClient = useWsStreamClient();
  // The host the mount-time probe asks. Its name has to come off the same
  // binding as the client - a host swap between the two reads would invalidate
  // one machine's queries for a run that happened on another. See
  // `StreamRuntimeBinding.hostId`.
  const ambientHostId = useStreamHostId();
  const runsRef = useRef<Map<string, HostRun>>(new Map());
  // The stream client this window has already asked "is a run going?". One
  // question per binding: a probe that came back empty must not be asked
  // again on the same connection every time a client closes, while a NEW
  // binding - the app pointed at another host - has never been asked at all.
  const probedStreamClientRef = useRef<object | null>(null);
  // Bumped whenever a client closes. Closing only mutates refs, and an effect
  // cannot see a ref change; without this, a run retained across a host swap
  // would close and leave the new host un-probed for the life of the window.
  const [clientGeneration, noteClientClosed] = useReducer(
    (generation: number) => generation + 1,
    0,
  );

  const closeRun = useCallback((hostId: string) => {
    const run = runsRef.current.get(hostId);
    if (run === undefined) return;
    runsRef.current.delete(hostId);
    run.client.close();
    // Returns the transport reference this run took at subscribe. A scoped
    // transport closes here if nothing else is reading it; the ambient one
    // has no lease to return.
    run.release?.();
    noteClientClosed();
  }, []);

  // The frames every subscription feeds the store from, whether it started
  // the run or found one going. The host is the run's, captured when it was
  // opened: the run outlives its binding, and by the time it completes the app
  // may be pointed somewhere else.
  const runCallbacks = useCallback(
    (hostId: string): SessionImportRunCallbacks => ({
      onStarted: (payload: SessionImportRunStartedPayload) => {
        useSessionImportRunStore.getState().applyStarted(hostId, {
          runId: payload.runId,
          total: payload.total,
          attached: payload.attached,
        });
      },
      onProgress: (payload: SessionImportRunProgressPayload) => {
        const entry = progressEntryFrom(payload);
        useSessionImportRunStore.getState().applyProgress(hostId, entry);
        // The task list's unread dot: each landed task is unseen until its
        // epic is first opened.
        if (entry.outcome.kind === "imported") {
          useImportedUnseenStore
            .getState()
            .markImported(entry.outcome.epicId, entry.harness);
        }
      },
      onComplete: (payload: SessionImportRunCompletePayload) => {
        useSessionImportRunStore.getState().applyComplete(hostId, {
          runId: payload.runId,
          counts: payload.counts,
        });
        // Imported sessions are real epics and chats; the task list and the
        // Settings entry's `lastCompleted` are both stale the instant the
        // run lands.
        void queryClient.invalidateQueries({
          queryKey: sessionImportQueryKeys.status(hostId),
        });
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.scope(hostId),
        });
        closeRun(hostId);
      },
      onConnectionStatus: (_status, reason) => {
        if (reason === null) return;
        if (!runsRef.current.has(hostId)) return;
        useSessionImportRunStore.getState().applyError(hostId);
        closeRun(hostId);
      },
    }),
    [closeRun, queryClient],
  );

  // Opens a subscription for one host and files it under that host. The
  // transport is pinned FIRST: the run outlives the surface that handed the
  // binding over, and a scoped transport closes at that surface's unmount
  // otherwise, taking this subscription with it.
  const openRun = useCallback(
    (input: {
      readonly target: SessionImportRunTarget;
      readonly selections: SessionImportRunRequest["selections"];
      readonly callbacks: SessionImportRunCallbacks;
      readonly waitingProbe: boolean;
    }): SessionImportRunClient => {
      const release = input.target.binding.retain?.() ?? null;
      const client = new SessionImportRunClient({
        wsStreamClient: input.target.binding.wsStreamClient,
        selections: input.selections,
        // Read at subscribe time, not rendered into: an imported chat starts
        // under the permission mode a NEW chat would get right now, which is
        // this install's default setting. The host has no default of its own.
        permissionMode: useSettingsStore.getState().defaultPermission,
        callbacks: input.callbacks,
      });
      runsRef.current.set(input.target.hostId, {
        client,
        release,
        waitingProbe: input.waitingProbe,
      });
      return client;
    },
    [],
  );

  const start = useCallback(
    (request: SessionImportRunRequest, target: SessionImportRunTarget) => {
      // One run at a time PER HOST is the contract; a second subscribe would
      // attach to the first and silently drop this submission's selections. A
      // probe still waiting for its answer is not a run, though: dropping the
      // user's click for it would lose the submission with nothing on screen
      // to say so. Close it and subscribe with the selections - if a run WAS
      // in flight, this subscribe attaches to it exactly as the probe would.
      const existing = runsRef.current.get(target.hostId);
      if (existing !== undefined) {
        if (!existing.waitingProbe) return;
        closeRun(target.hostId);
      }
      if (request.selections.length === 0) return;

      useSessionImportRunStore
        .getState()
        .markStarting(target.hostId, request.titles);
      openRun({
        target,
        selections: request.selections,
        callbacks: runCallbacks(target.hostId),
        waitingProbe: false,
      });
    },
    [closeRun, openRun, runCallbacks],
  );

  // Subscribing with no selections is the host's "attach to whatever is
  // running" form: a run in flight replays from the start, and an idle host
  // answers with an empty run instead. The store is touched only in the first
  // case - the probe closes on the empty answer before its `complete` frame
  // could read as "nothing was imported".
  //
  // Asked once per stream binding, and not gated on the store: after a host
  // swap the store may still hold the previous host's finished summary, and a
  // run in flight on the new host is the fresher fact - `applyStarted` lets a
  // new run id supersede it. A probe that finds nothing leaves the store as
  // it was.
  useEffect(() => {
    if (ambientStreamClient === null || ambientHostId === null) return;
    if (runsRef.current.has(ambientHostId)) return;
    if (probedStreamClientRef.current === ambientStreamClient) return;
    probedStreamClientRef.current = ambientStreamClient;

    const hostId = ambientHostId;
    const callbacks = runCallbacks(hostId);
    let attached = false;
    const probe = openRun({
      // The ambient binding never closes under its readers, so there is
      // nothing to pin: `retain: null` says exactly that.
      target: {
        binding: { wsStreamClient: ambientStreamClient, hostId, retain: null },
        hostId,
      },
      selections: [],
      waitingProbe: true,
      callbacks: {
        ...callbacks,
        onStarted: (payload) => {
          if (!payload.attached) {
            closeRun(hostId);
            return;
          }
          attached = true;
          // It is the run's subscription from here, not a question awaiting an
          // answer, so `start` must refuse rather than replace it.
          const run = runsRef.current.get(hostId);
          if (run !== undefined) run.waitingProbe = false;
          callbacks.onStarted(payload);
        },
      },
    });
    // Copied out of the ref for the cleanup: the map object itself never
    // changes for the life of this controller, so the copy reads the same
    // entries the cleanup would, without the lint rule's stale-ref worry.
    const runs = runsRef.current;
    return () => {
      // A probe still waiting for its answer when the client is replaced is
      // asking a connection that is gone; one that attached is the run's
      // subscription now and stays.
      const opened = runs.get(hostId);
      if (!attached && opened?.client === probe) {
        // Closed before the host answered (StrictMode's setup-cleanup-setup
        // replay, or the binding changed underneath it): the question was
        // never answered, so the next run of this effect asks again. Closed
        // by hand rather than through `closeRun`: that bumps the generation
        // this effect depends on, and a cleanup that re-runs its own effect
        // would close and re-ask without end.
        probedStreamClientRef.current = null;
        runs.delete(hostId);
        probe.close();
        opened.release?.();
      }
    };
  }, [
    ambientHostId,
    ambientStreamClient,
    clientGeneration,
    closeRun,
    openRun,
    runCallbacks,
  ]);

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
      for (const hostId of [...runsRef.current.keys()]) closeRun(hostId);
    },
    [closeRun],
  );

  return null;
}

interface HostRun {
  readonly client: SessionImportRunClient;
  /** Returns the transport lease this run took; `null` for the ambient one. */
  readonly release: (() => void) | null;
  /**
   * True while this client is the mount-time probe still waiting for the
   * host's answer, which is what lets `start` tell "a run is going" from "we
   * are still asking".
   */
  waitingProbe: boolean;
}
