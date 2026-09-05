import { useCallback, useEffect, useReducer, useRef } from "react";
import type { PermissionMode } from "@traycer/protocol/persistence/epic/schemas";
import { useQueryClient } from "@tanstack/react-query";
import {
  SessionImportRunClient,
  type SessionImportRunCallbacks,
  type SessionImportRunCompletePayload,
  type SessionImportRunProgressPayload,
  type SessionImportRunStartedPayload,
} from "@traycer-clients/shared/host-transport/session-import-run-client";
import { useStreamRuntimeBinding } from "@/lib/host/stream-runtime-context";
import { hostQueryKeys, sessionImportQueryKeys } from "@/lib/query-keys";
import {
  progressEntryFrom,
  useSessionImportRunStore,
} from "@/stores/session-import/session-import-run-store";
import { useImportedUnseenStore } from "@/stores/session-import/imported-unseen-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import {
  getSessionImportStartHandle,
  setSessionImportStartHandle,
  type SessionImportRunRequest,
  type SessionImportRunTarget,
} from "@/components/session-import/session-import-run-handle";

/**
 * The permission mode a NEW chat on this host would start under, read at
 * subscribe time: the last mode any composer ran with on that host, else the
 * install's default. That is exactly what the composer seeds a fresh chat
 * from, so an imported chat is no stricter and no looser than one the user
 * creates. The host has no default of its own to consult.
 */
function newChatPermissionModeFor(hostId: string): PermissionMode {
  return (
    useComposerRunSettingsStore.getState().getGlobalRunSettings(hostId)
      ?.permissionMode ?? useSettingsStore.getState().defaultPermission
  );
}

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
 * user's own selection. Only the ambient host is probed on the controller's
 * own initiative: a scoped host is asked about by the surface that opens a
 * wizard for it (`probeSessionImportRun`), since probing every host the
 * window could reach is a fan-out nothing has asked for. Either way the probe
 * takes the binding's lease, so a run it attaches to outlives the binding.
 */
export function SessionImportRunController(): null {
  const queryClient = useQueryClient();
  // The mount-time probe's target: client, host name and lease as ONE value,
  // so a host swap cannot pair one machine's client with another's name (see
  // `StreamRuntimeBinding.hostId`) and an attached run keeps the transport
  // alive past the swap.
  //
  // The effect below keys on this OBJECT, which every provider publishes once
  // per client (`StreamRuntimeBinding`'s contract): a binding re-minted per
  // render would close a waiting probe and re-ask it on every render.
  const ambientBinding = useStreamRuntimeBinding();
  const runsRef = useRef<Map<string, HostRun>>(new Map());
  // The stream client this window has already asked "is a run going?" ON ITS
  // OWN INITIATIVE. One question per ambient binding: a probe that came back
  // empty must not be asked again on the same connection every time a client
  // closes, while a NEW binding - the app pointed at another host - has never
  // been asked at all. A surface's probe (`probe` below) is deliberately not
  // recorded here: a wizard re-asks on every open, since another window may
  // have started a run since, and an empty answer costs the host nothing.
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
    // Returns the transport reference this run took at subscribe, so a
    // transport nothing else is reading closes here. `null` only for a
    // binding that declared nothing to pin.
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
      readonly probeOrigin: ProbeOrigin | null;
    }): SessionImportRunClient => {
      const release = input.target.binding.retain?.() ?? null;
      const client = new SessionImportRunClient({
        wsStreamClient: input.target.binding.wsStreamClient,
        selections: input.selections,
        permissionMode: newChatPermissionModeFor(input.target.hostId),
        callbacks: input.callbacks,
      });
      runsRef.current.set(input.target.hostId, {
        client,
        release,
        waitingProbe: input.waitingProbe,
        probeOrigin: input.probeOrigin,
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
        probeOrigin: null,
      });
    },
    [closeRun, openRun, runCallbacks],
  );

  // Opens the "attach to whatever is running" subscription for one target.
  // Subscribing with no selections is the host's form for that: a run in
  // flight replays from the start, and an idle host answers with an empty run
  // instead. The store is touched only in the first case - the probe closes
  // on the empty answer before its `complete` frame could read as "nothing
  // was imported".
  const openProbe = useCallback(
    (input: {
      readonly target: SessionImportRunTarget;
      readonly origin: ProbeOrigin;
    }): SessionImportRunClient => {
      const { target } = input;
      const hostId = target.hostId;
      const callbacks = runCallbacks(hostId);
      return openRun({
        target,
        selections: [],
        waitingProbe: true,
        probeOrigin: input.origin,
        callbacks: {
          ...callbacks,
          onStarted: (payload) => {
            if (!payload.attached) {
              closeRun(hostId);
              return;
            }
            // It is the run's subscription from here, not a question awaiting
            // an answer, so `start` must refuse rather than replace it.
            const run = runsRef.current.get(hostId);
            if (run !== undefined) run.waitingProbe = false;
            callbacks.onStarted(payload);
          },
        },
      });
    },
    [closeRun, openRun, runCallbacks],
  );

  // A surface's question about the host it renders under. Nothing to ask
  // while this window already runs, or is already asking, that host.
  const probe = useCallback(
    (target: SessionImportRunTarget): void => {
      if (runsRef.current.has(target.hostId)) return;
      openProbe({ target, origin: "surface" });
    },
    [openProbe],
  );

  // The surface's question withdrawn: its wizard closed before the host
  // answered. Only a SURFACE probe still waiting is closed - one that attached
  // is the run's subscription now and stays, and the ambient probe is the
  // controller's own question, cleaned up by its own effect. Without this a
  // scoped transport pinned by an unanswered probe stayed open for as long as
  // a wedged host kept the socket alive.
  const cancelProbe = useCallback(
    (target: SessionImportRunTarget): void => {
      const run = runsRef.current.get(target.hostId);
      if (run === undefined || !run.waitingProbe) return;
      if (run.probeOrigin !== "surface") return;
      closeRun(target.hostId);
    },
    [closeRun],
  );

  // The ambient host is asked once per stream binding, and not gated on the
  // store: after a host swap the store may still hold the previous host's
  // finished summary, and a run in flight on the new host is the fresher
  // fact - `applyStarted` lets a new run id supersede it. A probe that finds
  // nothing leaves the store as it was.
  useEffect(() => {
    if (ambientBinding === null || ambientBinding.hostId === null) return;
    const hostId = ambientBinding.hostId;
    if (probedStreamClientRef.current === ambientBinding.wsStreamClient) return;
    // Recorded BEFORE the "already running" check: a host this window is
    // already running or asking has been asked, as far as this binding is
    // concerned, and must not be re-asked on the next generation bump.
    probedStreamClientRef.current = ambientBinding.wsStreamClient;
    if (runsRef.current.has(hostId)) return;

    const ambientProbe = openProbe({
      target: { binding: ambientBinding, hostId },
      origin: "ambient",
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
      if (opened?.client === ambientProbe && opened.waitingProbe) {
        // Closed before the host answered (StrictMode's setup-cleanup-setup
        // replay, or the binding changed underneath it): the question was
        // never answered, so the next run of this effect asks again. Closed
        // by hand rather than through `closeRun`: that bumps the generation
        // this effect depends on, and a cleanup that re-runs its own effect
        // would close and re-ask without end.
        probedStreamClientRef.current = null;
        runs.delete(hostId);
        ambientProbe.close();
        opened.release?.();
      }
    };
  }, [ambientBinding, clientGeneration, openProbe]);

  useEffect(() => {
    setSessionImportStartHandle({ start, probe, cancelProbe });
    return () => {
      if (getSessionImportStartHandle()?.start === start) {
        setSessionImportStartHandle(null);
      }
    };
  }, [cancelProbe, probe, start]);

  useEffect(
    () => () => {
      for (const hostId of [...runsRef.current.keys()]) closeRun(hostId);
    },
    [closeRun],
  );

  return null;
}

/** Who asked: the controller at mount (`ambient`) or a wizard (`surface`). */
type ProbeOrigin = "ambient" | "surface";

interface HostRun {
  readonly client: SessionImportRunClient;
  /**
   * Returns the transport lease this run took; `null` only when the binding
   * declared nothing to pin.
   */
  readonly release: (() => void) | null;
  /**
   * True while this client is a probe still waiting for the host's answer,
   * which is what lets `start` tell "a run is going" from "we are still
   * asking".
   */
  waitingProbe: boolean;
  /** Which probe this was, for `cancelProbe`; irrelevant once attached. */
  readonly probeOrigin: ProbeOrigin | null;
}
