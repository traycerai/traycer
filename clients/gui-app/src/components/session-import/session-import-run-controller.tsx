import { useCallback, useEffect, useReducer, useRef } from "react";
import type { PermissionMode } from "@traycer/protocol/persistence/epic/schemas";
import { useQueryClient } from "@tanstack/react-query";
import { sessionImportRunV12 } from "@traycer/protocol/host/session-import/run";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { IStreamClient } from "@traycer-clients/shared/host-transport/i-stream-client";
import {
  SessionImportRunClient,
  type SessionImportRunCallbacks,
  type SessionImportRunCompletePayload,
  type SessionImportRunProgressPayload,
  type SessionImportRunStartedPayload,
} from "@traycer-clients/shared/host-transport/session-import-run-client";
import { fallbackPermissionMode } from "@/components/home/data/landing-options";
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
  type SessionImportActiveRun,
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
 * The mode the run is actually opened under: the new-chat default above,
 * demoted (`auto` → `auto_accept_edits`) unless this host has SHOWN it knows
 * `auto`.
 *
 * `permissionMode` rides in the `sessionImport.run` OPEN request. `1.0` and
 * `1.1` bind `sessionImportRunOpenRequestSchemaPreAuto` and only `1.2` binds the
 * live enum, so a pre-`1.2` host REJECTS the value - after the user has picked
 * their sessions, which is the cost this check exists to avoid. (An earlier
 * version of this note said all three lines shared one live-enum request; they
 * were separated when the frozen pre-Auto request was introduced, and the
 * client-owes-the-check conclusion is unchanged either way.)
 *
 * Demotion is one-way and never elevates: `auto` is `auto_accept_edits` plus a
 * judge, so dropping the judge is the honest half-measure, while
 * `normalizePermissionMode`'s safest-supported walk would land on `supervised`
 * and make an import stricter than the user's own default. Every other mode
 * predates the split and passes through untouched.
 */
function importPermissionModeFor(input: {
  readonly hostId: string;
  readonly wsStreamClient: IStreamClient<HostStreamRpcRegistry>;
}): PermissionMode {
  const mode = newChatPermissionModeFor(input.hostId);
  if (mode !== "auto") return mode;
  return hostUnderstandsAutoPermissionMode(input)
    ? mode
    : fallbackPermissionMode(mode);
}

/**
 * Whether this host has PROVEN it understands `auto`. Two independent facts can
 * prove it, and **both are about `sessionImport.run` itself** - which is the
 * correction that matters here:
 *
 *   - the negotiated line of a LIVE `sessionImport.run` session, which
 *     `getMethodSchemaVersion` reports first when one exists;
 *   - failing that, the line this host ADVERTISED for the method in its STREAM
 *     handshake. `WsStreamClient.applyHostManifest` walks every method in the
 *     peer manifest, not just the subscribed one, and caches what a subscribe
 *     would declare - so any stream handshake with this host (a chat tile, an
 *     epic subscription) answers for `sessionImport.run` without one ever
 *     having been opened. `getMethodSchemaVersion` already falls through to
 *     that cache, which is why both facts come from the SAME call.
 *
 * **The unary manifest is not one of them, and used to be.** This fell back to
 * `getNegotiatedHostMethodVersion(hostId, "sessionImport.run")` on the stated
 * reasoning that `ws-rpc-client.ts` records "the host's whole manifest" on
 * every unary openAck. It records the whole UNARY manifest:
 * `sessionImport.run` is a stream method
 * (`HOST_STREAM_RPC_REGISTRY_OTHER_DEFINITION`), the host derives its unary
 * openAck manifest from the unary registry alone, and so that read returned
 * `null` for every host that has ever connected. The fallback could not fire,
 * and a capable host silently got `auto_accept_edits` instead of the user's
 * `auto`. `src/__tests__/stream-method-not-in-unary-manifest.test.ts` is the
 * scan that stops this being written a third time.
 *
 * **What is deliberately NOT a proof any more: the harness catalog.** This used
 * to fall through to `agent.gui.listHarnesses` rows offering `auto`, with a
 * manifest-based veto in front of it. That is a different method's fact, and
 * per-method negotiation is exactly the rule it breaks: a catalog at `9.1`
 * says the host can spell `auto` in a catalog ROW and says nothing about which
 * `sessionImport.run` line the eventual stream negotiates. A host advertising
 * `run@1.1` would have had `auto` put into an open request that rejects it,
 * losing the import the user had already picked sessions for. The stream
 * handshake's cached manifest covers every case the catalog was introduced for
 * - it is filled by any stream to this host - without inferring across methods,
 * and it is CONNECTION-scoped, so a host that came back on an older build has
 * already overwritten it.
 *
 * The read is synchronous because the mode rides the stream's OPEN request;
 * nothing on this path can await one.
 *
 * Neither provable is "not proven", not "old host", and it demotes: an `auto` a
 * pre-auto host cannot parse costs the user their whole import, while a
 * demotion costs them the judge on one they can re-run. The minor is compared
 * against the exported contract, never a literal, so a rebase that renumbers it
 * moves this with it.
 */
function hostUnderstandsAutoPermissionMode(input: {
  readonly wsStreamClient: IStreamClient<HostStreamRpcRegistry>;
}): boolean {
  const negotiated =
    input.wsStreamClient.getMethodSchemaVersion("sessionImport.run");
  const required = sessionImportRunV12.schemaVersion;
  if (negotiated !== null) {
    if (
      negotiated.major === required.major &&
      negotiated.minor >= required.minor
    ) {
      return true;
    }
    // A live session that names an OLDER line is a definitive no, and nothing
    // below may overturn it: this is the method's own handshake, on the very
    // connection the open request is about to ride.
    if (versionIsBelow(negotiated, required)) return false;
  }
  // Nothing further to ask. The advertised line is already folded into the read
  // above - `getMethodSchemaVersion` answers from the live session first and
  // the stream handshake's cached manifest second - so a separate lookup here
  // would either restate that answer or, as the unary-manifest read it used to
  // be, answer `null` forever. Unproven demotes, which is the direction this
  // whole predicate is built around.
  return false;
}

/**
 * Whether `advertised` names a line strictly BELOW `line`.
 *
 * A HIGHER major answers `false`, and that is the deliberate part: it is not
 * evidence of being below, and both callers use this to DEMOTE. Failing closed
 * on a higher major is right for a floor that gates a dispatch
 * (`negotiatedVersionMeetsRequirement`) and wrong here, where it would silently
 * demote every import on the first host to ship the next major of either
 * method.
 *
 * Shared by the two veto sites so they cannot drift into disagreeing about what
 * "older" means - they already had the same three-branch comparison written out
 * twice, which is one copy more than a rule this easy to get subtly wrong wants.
 */
function versionIsBelow(
  advertised: SchemaVersion,
  line: SchemaVersion,
): boolean {
  if (advertised.major !== line.major) return advertised.major < line.major;
  return advertised.minor < line.minor;
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
 * user's own selection. Only the ambient host is probed: a scoped host is
 * asked about by the surface that opens it, and probing every host the window
 * could reach is a fan-out nothing has asked for.
 */
export function SessionImportRunController(): null {
  const queryClient = useQueryClient();
  const ambientBinding = useStreamRuntimeBinding();
  const ambientStreamClient = ambientBinding?.wsStreamClient ?? null;
  // The host the mount-time probe asks. Its name has to come off the same
  // binding as the client - a host swap between the two reads would invalidate
  // one machine's queries for a run that happened on another. See
  // `StreamRuntimeBinding.hostId`.
  const ambientHostId = ambientBinding?.hostId ?? null;
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
    // transport closes here if nothing else is reading it. Ambient runs also
    // retain their transport across a change of the window's host.
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
        permissionMode: importPermissionModeFor({
          hostId: input.target.hostId,
          wsStreamClient: input.target.binding.wsStreamClient,
        }),
        callbacks: input.callbacks,
      });
      runsRef.current.set(input.target.hostId, {
        client,
        release,
        waitingProbe: input.waitingProbe,
      });
      return client;
    },
    // No dependencies: the permission-mode resolution reads the live session's
    // negotiated version and the connection manifest, neither of which is a
    // React value. It used to close over `queryClient` for a cached catalog
    // read that is no longer consulted.
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

  const attach = useCallback(
    (target: SessionImportRunTarget, run: SessionImportActiveRun): void => {
      const hostId = target.hostId;
      const existing = runsRef.current.get(hostId);
      if (existing !== undefined) {
        if (!existing.waitingProbe) return;
        // This status-confirmed attach must own the answer. An ambient probe
        // can find the run already finished and otherwise leave the wizard
        // waiting on its stale active status forever.
        closeRun(hostId);
      }
      // The status query already named a real run. Keep that identity even
      // if the connection fails before the stream's first frame arrives.
      useSessionImportRunStore.getState().applyStarted(hostId, {
        runId: run.runId,
        total: run.total,
        attached: true,
      });
      const callbacks = runCallbacks(hostId);
      let attached = false;
      openRun({
        target,
        selections: [],
        waitingProbe: false,
        callbacks: {
          ...callbacks,
          onStarted: (payload) => {
            attached = payload.attached;
            if (attached) {
              callbacks.onStarted(payload);
              return;
            }
            // The run finished between the status reply and the attach.
            // Recheck before offering selections; the empty run is no summary.
            closeRun(hostId);
            void queryClient.invalidateQueries({
              queryKey: sessionImportQueryKeys.status(hostId),
            });
            useSessionImportRunStore.getState().reset(hostId);
          },
          onComplete: (payload) => {
            if (attached) callbacks.onComplete(payload);
          },
        },
      });
    },
    [closeRun, openRun, queryClient, runCallbacks],
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
    if (ambientBinding === null || ambientHostId === null) return;
    if (runsRef.current.has(ambientHostId)) return;
    if (probedStreamClientRef.current === ambientStreamClient) return;
    probedStreamClientRef.current = ambientStreamClient;

    const hostId = ambientHostId;
    const callbacks = runCallbacks(hostId);
    let attached = false;
    const probe = openRun({
      target: {
        binding: ambientBinding,
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
    ambientBinding,
    ambientHostId,
    ambientStreamClient,
    clientGeneration,
    closeRun,
    openRun,
    runCallbacks,
  ]);

  useEffect(() => {
    setSessionImportStartHandle({ start, attach });
    return () => {
      if (getSessionImportStartHandle()?.start === start) {
        setSessionImportStartHandle(null);
      }
    };
  }, [start, attach]);

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
  /** Returns the transport lease this run took, when the binding provides one. */
  readonly release: (() => void) | null;
  /**
   * True while this client is the mount-time probe still waiting for the
   * host's answer, which is what lets `start` tell "a run is going" from "we
   * are still asking".
   */
  waitingProbe: boolean;
}
