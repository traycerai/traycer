import {
  spawnEpicRuntimeWorker,
  type EpicRuntimeBodyReturnTarget,
} from "@/stores/epics/open-epic/runtime/worker/spawn-epic-runtime-worker";
import { createProcessBackedAccountingPort } from "@/stores/epics/open-epic/runtime/process-backed-accounting-port";
import { createRendererRuntimeEnvironment } from "@/stores/epics/open-epic/runtime/runtime-environment";
import { dispatchEpicWriteCommand } from "@/stores/epics/open-epic/runtime/epic-write-command-dispatch";
import { dispatchEpicLaneUnary } from "@/stores/epics/open-epic/runtime/epic-lane-unary-dispatch";
import {
  classifyEpicWriteCommandFailure,
  readWriteCommandIntent,
} from "@/stores/epics/open-epic/runtime/epic-write-command";
import { createLateBoundProjectionTarget } from "@/stores/epics/open-epic/runtime/worker/late-bound-projection-target";
import type { EpicRuntimeProjection } from "@/stores/epics/open-epic/runtime/epic-runtime-projection";
import { appLogger } from "@/lib/logger";
import {
  createOpenEpicStore,
  isProjectionPatch,
  type OpenEpicState,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { AttributableDurableStreamTransport } from "@/lib/host/durable-stream-transport";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { attachPlanRestrictedReprobe } from "@/lib/host/owned-durable-stream-client";
import {
  getEpicRuntimeWorkerFactory,
  handleHostIds,
  handleStreamClients,
  trackEpicSessionHandleLiveness,
  trackEpicSessionTransportCloseAttribution,
  type EpicSessionTransportCloseTrigger,
} from "@/lib/registries/epic-session-registry";

/**
 * The mechanical kernel of an Epic session: transport, worker, store, close
 * attribution, liveness and the two construction stamps.
 *
 * Lifted out of `providers/epic-session-provider.tsx` UNCHANGED - this module
 * decides nothing about WHEN a session is built, adopted, re-pointed, parked or
 * retired. Those remain the provider's (and, after the controller lands, the
 * controller's); what moved is the one function that turns a host id into a
 * live handle, so a caller that is not a React mount can run it.
 *
 * SIBLING of the registry module rather than part of it, and it imports the
 * stamp maps from there rather than declaring them: the maps have to live in
 * the module that holds the registry INSTANCE handing back warm handles, so
 * that no module replacement can leave a surviving warm handle whose stamp was
 * left behind. That colocation is load-bearing (F1) and unchanged by this
 * extraction - see `requireConstructionHostStamp` in the provider, and
 * {@link handleStreamClients}'s own doc. Importing them here rather than
 * moving them also keeps the direction acyclic: the registry never imports
 * this module, and a change to this one propagates to its importers without
 * replacing the registry underneath the warm handles.
 */

/** Passed to `reconnectAll` so a hand-driven wake is distinguishable in logs. */
const EPIC_SESSION_WAKE_REASON = "user-retry";

/**
 * The provider's current pointing, read at CALL time.
 *
 * Two handles are live at once during a re-point: the outgoing one is still
 * registered and still issuing writes for the rows it projected, while the
 * incoming one's `attach()` has already started its own tab-open workspace
 * context read. So a requester is resolved BY HOST ID off this snapshot rather
 * than from one "the session's client" read - a single read sent the
 * candidate's `epic.getWorkspaceContext` to A while its streams, its accounting
 * stamp and its worker bootstrap all said B, which is `bridge-protocol.ts`'s
 * "a worker never serves two hosts" broken.
 */
export interface EpicSessionRequesterTarget {
  /** The host the provider is currently POINTING at. */
  readonly targetHostId: string | null;
  readonly targetHostClient: HostClient<HostRpcRegistry> | null;
  /** The host the provider is currently SERVING, `null` before a session. */
  readonly sessionHostId: string | null;
  readonly sessionHostClient: HostClient<HostRpcRegistry> | null;
}

/**
 * The requester for one handle's OWN construction host, or a refusal.
 *
 * REFUSING is the point rather than a gap: both dispatchers answer a `null`
 * requester with a refusal the caller can see, where falling back to "whatever
 * is live" would BE the cross-host send. Not `targetHostId` unconditionally
 * either - the outgoing handle is still mounted and still issuing writes, and
 * re-aiming it at the incoming host is the same cross-host send pointed the
 * other way.
 */
export function epicSessionRequesterForHostId(
  target: EpicSessionRequesterTarget,
  hostId: string,
): HostClient<HostRpcRegistry> | null {
  if (hostId === target.targetHostId) return target.targetHostClient;
  if (target.sessionHostId !== null && hostId === target.sessionHostId) {
    return target.sessionHostClient;
  }
  return null;
}

/**
 * Everything the kernel needs that is NOT a fact about the handle it is
 * building - the provider's captured closures, made explicit.
 */
export interface EpicSessionHandleSpec {
  readonly epicId: string;
  /**
   * The host THIS handle is constructed against: the value the transport is
   * opened with, the accounting port is built with, and the construction stamp
   * is written from. Named as the HANDLE's host rather than the caller's
   * target, because the requester it feeds has to keep meaning that after the
   * caller has re-pointed away from it - a read of the caller's current target
   * there is the same defect one re-point later.
   */
  readonly hostId: string;
  /** The canonical `profile.userId`; `null` is signed-out / hydrating. */
  readonly userId: string | null;
  readonly openTransport: (
    hostId: string,
  ) => AttributableDurableStreamTransport;
  /**
   * Read fresh on every dispatch. A handle's requester is consulted per call,
   * and these clients legitimately rotate (reconnect, identity re-point)
   * without that being a reason to tear down and reacquire the session.
   */
  readonly readRequesterTarget: () => EpicSessionRequesterTarget;
  /**
   * The host terminated the epic stream with `UNAUTHORIZED`, so the current
   * context bearer is no longer accepted. The caller re-validates the live
   * RequestContext; single-flight and idempotent, so it needs no callback
   * timing.
   */
  readonly onAuthError: () => void;
  /**
   * Adopt the pre-`userId` persist bucket, called before the store exists
   * because `persist` reads its key at creation. A no-op when there is no
   * legacy key to adopt.
   */
  readonly adoptLegacyPersistKey: (userId: string) => void;
  /**
   * This session's transport reached its plan-restricted reprobe deadline.
   * The owner-level backoff ladder stays with the caller; this is the denial
   * it schedules against, carrying the handle that observed it as the ladder's
   * owner.
   */
  readonly onPlanRestrictedDenial: (owner: OpenEpicStoreHandle) => void;
  /**
   * A loaded replica on an open transport - the only evidence that a previous
   * plan denial ended. A construction or a transient `connecting` projection
   * does not reach here.
   */
  readonly markHealthy: () => void;
  /**
   * The runtime worker behind the bridge is gone. RECORDED on the handle here
   * (so the next acquisition can retire it) and reported to the caller, which
   * owns the presentation carrying the Retry affordance.
   */
  readonly onRuntimeFatal: () => void;
  /**
   * The store asked for a transport rebuild after a plan denial. Marked dead
   * here for the same reason as the fatal above; the caller owns the retry.
   */
  readonly onRetryTransport: () => void;
}

/**
 * Build one Epic session handle, or throw.
 *
 * A synchronous throw leaves NO transport behind: every construction between
 * opening the socket and returning a handle that owns its close runs inside one
 * rollback, because the leak is a property of that WINDOW rather than of any
 * one call inside it.
 */
export function createEpicSessionHandle(
  spec: EpicSessionHandleSpec,
): OpenEpicStoreHandle {
  const { epicId, hostId, userId } = spec;
  const requesterForHandleHost = (): HostClient<HostRpcRegistry> | null =>
    epicSessionRequesterForHostId(spec.readRequesterTarget(), hostId);
  // Before the store exists, because `persist` reads its key at creation: the
  // bucket used to be named by the email, and re-keying without this would
  // silently reset every install's focus state on upgrade.
  if (userId !== null) spec.adoptLegacyPersistKey(userId);
  // ── The session's ONE transport ────────────────────────────────────────────
  //
  // The session OWNS its transport, and now literally rather than by there
  // happening to be a single client. Every stream client this session builds -
  // the `@1` arm, the records lane, the control lane, and the per-artifact body
  // lanes - rides THIS transport's `wsStreamClient`, because `WsStreamClient`
  // multiplexes methods over one socket and `openTransport` is not pooled.
  // Opening one transport per client would give an epic two sockets on the lane
  // arm and one more per open tile, which is worse than the `@1` monolith on
  // exactly the axis the lane cutover exists to improve.
  //
  // It is opened HERE, before any client, because adapter selection reads this
  // connection's negotiated method support off it and has to do so before
  // deciding what to open. The registry only closes the handle when it DISPOSES
  // the session, so the socket survives the MRU warm window; the durable
  // transport's live endpoint + wake re-dial heal a host restart under a stable
  // `hostId` on their own, and one reconnect now resumes every client riding it
  // rather than one client each. A revived session is a NEW handle and
  // therefore a new transport - this one is never handed on.
  //
  // ALWAYS opened. There used to be a branch here that skipped the transport
  // when a test had installed a stream-factory override, on the reasoning that
  // "the override IS a test supplying this session's stream". That branch
  // produced a null `wsStreamClient` and the guard below then threw
  // unconditionally, so installing the override could not do anything except
  // fail - two comments in this one function stating opposite contracts, with
  // the code implementing both.
  //
  // The seam that survives the relocation is the WORKER factory, not the stream
  // factory: the worker builds its own typed clients over a proxied
  // `IStreamClient`, and a factory constructed on MAIN cannot cross
  // `postMessage` to reach it. A suite that wants to drive this session's
  // stream supplies a fake TRANSPORT at this opener instead, and gets the real
  // proxy path underneath it.
  const transport = spec.openTransport(hostId);
  const wsStreamClient = transport.wsStreamClient;
  let transportClosed = false;
  let pendingTransportCloseTrigger: EpicSessionTransportCloseTrigger | null =
    null;
  let detachSessionHealthy: (() => void) | null = null;
  // Filled once the handle exists, because the recovery IS the handle's
  // `retryTransport`. Held in a slot rather than passed in because the
  // subscription has to be live before then: the negative-cache adoption path
  // can hand back an ALREADY-closed client, and `onClosed` does not retro-fire,
  // so a deadline that landed during construction would be lost if this
  // attached afterwards.
  let reprobeHandle: OpenEpicStoreHandle | null = null;
  // The handle this run stamped into `handleStreamClients`, so the close below
  // can un-stamp it. A slot for the same reason `reprobeHandle` is one: the
  // close is composed before the handle exists, and a construction that throws
  // must leave no entry behind.
  let streamStampedHandle: OpenEpicStoreHandle | null = null;
  const detachReprobe = attachPlanRestrictedReprobe(wsStreamClient, () => {
    const deniedHandle = reprobeHandle;
    if (deniedHandle === null) return;
    // Capture this exact owner. If its replacement is denied before a delayed
    // rung fires, the ladder replaces this callback with the newer handle's
    // rather than calling through a mutable slot.
    spec.onPlanRestrictedDenial(deniedHandle);
  });
  const closeSessionTransport = (
    fallbackTrigger: EpicSessionTransportCloseTrigger,
  ): void => {
    if (transportClosed) return;
    transportClosed = true;
    // Only if it is still OURS: a repoint closes the old handle's transport
    // after the new one has already published itself, and clearing
    // unconditionally there would blind the silence gate to a live socket.
    // Keyed by handle, so the two sessions cannot collide in the first place -
    // the value check is what keeps that true if a handle is ever re-stamped.
    if (
      streamStampedHandle !== null &&
      handleStreamClients.get(streamStampedHandle) === wsStreamClient
    ) {
      handleStreamClients.delete(streamStampedHandle);
    }
    // Before `transport.close()`, so the timer cannot outlive the socket it
    // exists to rebuild.
    detachReprobe();
    detachSessionHealthy?.();
    detachSessionHealthy = null;
    // The transport owns ordering: it tears down wake/endpoint wiring before
    // closing the socket with this attributed reason. Keeping the
    // `durable-transport-closed` prefix preserves existing log searches.
    const trigger = pendingTransportCloseTrigger ?? fallbackTrigger;
    transport.closeWithReason(`durable-transport-closed:${trigger}`);
  };
  // EVERY construction between opening the transport and returning a handle
  // that owns its close. A synchronous throw anywhere in here - `new Worker`
  // refused by the runtime or CSP, an emitted worker URL that will not load, an
  // accounting port that cannot be built - propagated with the transport
  // already open and NO handle in existence, so neither `dispose` nor
  // `detachTransport` could ever reach `closeSessionTransport` and the socket
  // stayed dialling for the life of the window. The epic also failed outside
  // the `failed` presentation, which is the state carrying the Retry
  // affordance.
  //
  // Scoped to the whole span rather than to the worker spawn the symptom
  // pointed at: the leak is a property of the WINDOW between acquiring the
  // socket and handing back its owner, not of any one call inside it.
  try {
    // The four typed stream clients are NOT built here any more. They are the
    // method-typed zod decode this relocation exists to move, so the worker
    // builds them itself over its proxied `IStreamClient`
    // (`buildProxiedStreamFactories`). What crosses is this session's real
    // `wsStreamClient`, whose socket never leaves this thread.
    //
    // There is deliberately no "no transport" guard left. One stood here and
    // threw, which was the right posture while a branch above could produce a
    // null client; with that branch gone, `DurableStreamTransport` declares
    // `wsStreamClient` non-nullable and the check became unreachable - and a
    // dead `=== null` is what `no-unnecessary-condition` exists to reject. The
    // property is carried by the TYPE now, which is the stronger form of the
    // same guarantee: a runtime throw catches a null that reaches it, whereas
    // this one cannot be constructed.

    /**
     * The books, on MAIN, and the one set for this session.
     *
     * Built here rather than in the store because the worker reports into them
     * too, over the bridge - so the composition that spawns the worker is the
     * composition that owns them.
     */
    const accounting = createProcessBackedAccountingPort({
      hostId,
      epicId,
      environment: createRendererRuntimeEnvironment(),
    });

    /**
     * The projection handlers, filled once the store exists.
     *
     * A slot because the two constructions are mutually dependent: the spawner
     * reduces into handlers only the store can supply, and the store needs the
     * port only the spawner can hand back. The worker cannot publish before its
     * bootstrap is answered, and that happens after both lines below - so the
     * window where this is `null` carries no traffic. It is still checked
     * rather than asserted, because "cannot happen" is not a thing this file
     * gets to claim about another thread.
     */
    // Buffers publications made before the store exists, and answers `accept`
    // from a pure parser so a `null` there means "foreign payload" and never
    // "no target yet". The worker composes and starts INSIDE the spawn below,
    // so that window carries real traffic.
    const projection = createLateBoundProjectionTarget<
      Partial<EpicRuntimeProjection>
    >(
      (value) => (isProjectionPatch(value) ? value : null),
      (reason, revision) => {
        appLogger.warn(
          "[open-epic] dropped a projection publication before attach",
          { epicId, reason, revision },
        );
      },
    );
    /**
     * The body plane's return leg, filled on the same line as the one above and
     * `null` for the same window. The store owns the live body docs, so this is
     * mutually dependent with the spawn in exactly the way the projection slot
     * is.
     */
    // NOT buffered, and derived rather than assumed. The body return leg
    // publishes only from observers attached inside the `body/materialize`
    // handler (`epic-runtime-core-ports.ts` - both call sites, the cold arm and
    // the forward-only one). A materialize is a CALL issued by the lease
    // bridge, and the lease bridge is built by the store - so no body
    // publication can precede the store, and this slot has no gap to lose
    // traffic in. Contrast the projection slot above, whose producer runs
    // during composition.
    let bodyTarget: EpicRuntimeBodyReturnTarget | null = null;

    // Created BEFORE the spawn and mapped to the handle after it, because a
    // protocol-mismatch fatal arrives synchronously from inside
    // `spawnEpicRuntimeWorker` - before `handle` exists. See
    // `handleWorkerLiveness` for why this is a cell rather than a set entry.
    const liveness = { dead: false };

    const runtimeWorker = spawnEpicRuntimeWorker<
      Partial<EpicRuntimeProjection>
    >({
      createWorker: getEpicRuntimeWorkerFactory(),
      relay: {
        log: (entry) => {
          // The worker's own level, mapped onto the four this logger has.
          // `debug` is the floor: a relocated module's chatter must not
          // arrive as an error just because it crossed a thread.
          if (entry.level === "error") {
            appLogger.error(entry.message, entry.fields, entry.error);
            return;
          }
          if (entry.level === "warn") {
            appLogger.warn(entry.message, entry.fields);
            return;
          }
          appLogger.debug(entry.message, entry.fields);
        },
        fatal: (message, stack) => {
          // NOT just a log line. The runtime behind the bridge is gone, so a
          // UI waiting on projections would wait forever - the epic reads as
          // permanently loading. Surfaced as `failed`, which is the state
          // that carries a retry affordance.
          appLogger.error(
            "[epic-session] runtime worker fatal",
            { epicId },
            { message, stack },
          );
          // RECORDED, not acted on. `failed` is the presentation that carries
          // the Retry affordance, and Retry alone could not recover: it bumps
          // the retry generation, the acquire pass sees the same target host,
          // and presents this same dead handle as `ready` - the affordance
          // unable to recover from the one failure it is shown for. Marking
          // the handle is what lets that pass retire it instead.
          //
          // Marked rather than disposed HERE because this runs on a bridge
          // callback that can be inside the registry's own acquire
          // transaction; the acquiring caller owns registry mutation and
          // reads this on its next pass.
          liveness.dead = true;
          spec.onRuntimeFatal();
        },
      },
      // Classified HERE, on main: an `Error` does not survive structured
      // clone, so the worker receives the classifier's own union.
      writeCommand: async (commandId, intent) => {
        const narrowed = readWriteCommandIntent(intent);
        if (narrowed === null) {
          return {
            ok: false,
            failure: {
              kind: "rejected",
              resolution: {
                kind: "rejected",
                code: "RPC_ERROR",
                reason: "unrecognised write command intent",
                retryable: false,
              },
            },
          };
        }
        try {
          const sent = await dispatchEpicWriteCommand(
            { epicId, requester: requesterForHandleHost },
            commandId,
            narrowed,
          );
          return { ok: true, hostId: sent.hostId };
        } catch (cause: unknown) {
          return {
            ok: false,
            failure: classifyEpicWriteCommandFailure(cause),
          };
        }
      },
      // Reduced HERE, on main, for the same reason `writeCommand` is: an
      // `Error` does not survive structured clone.
      laneUnary: (request) =>
        dispatchEpicLaneUnary(
          { epicId, requester: requesterForHandleHost },
          request,
        ),
      streams: wsStreamClient,
      // The SAME object as `streams`, narrowed to the two members the
      // manifest is built from - see the option's own doc for why the two are
      // separate parameters rather than one widened one.
      methodSupport: wsStreamClient,
      accounting,
      projection: projection.handlers,
      body: {
        applyDocUpdate: (docKey, update) => {
          bodyTarget?.applyDocUpdate(docKey, update);
        },
        applyAwareness: (docKey, frame) => {
          bodyTarget?.applyAwareness(docKey, frame);
        },
      },
      epicId,
      // The host this session was established against, which is the same
      // value the accounting port is built with above. The worker's
      // write-command queue reads it as its send gate - see
      // `RuntimeWorkerBootstrap.hostId`.
      hostId,
      windowLabel: epicId,
    });

    const created = createOpenEpicStore({
      epicId,
      userId,
      // The same value the runtime binding above was built with - see its own
      // comment. Carried onto the handle so the registry's cap-guard can tell
      // whether the activity plane speaks for this session.
      hostId,
      accounting,
      // The rebuild half of the plan-denial reprobe. The store decides WHETHER
      // (it owns the dirtiness that makes a rebuild lossy here); this decides
      // HOW, because the transport is this module's.
      //
      // Retiring and re-acquiring rather than reconnecting: the closed client
      // cannot acquire the negative cache's controlled fresh session, which is
      // the whole reason the deadline exists. Marking the handle dead is what
      // lets the acquire pass RETIRE it - without it that pass sees the same
      // target host and re-presents this same closed handle as `ready`, which
      // is the failure mode the worker-fatal path above records for the user's
      // own Retry.
      //
      // No presentation is written here. A clean session rebuilding after a
      // deadline the user never saw should not flash a failure at them; the
      // acquire pass presents `establishing` on its own.
      onRetryTransport: () => {
        liveness.dead = true;
        spec.onRetryTransport();
      },
      // THIS session's socket, never the app-wide one. Every surface owns its
      // own transport - a chat opens one per session, and this opener holds the
      // epic's - so a wake resolved from anywhere else would collapse the
      // backoff on a connection the user is not waiting for and leave theirs
      // sitting out its delay. `probeFirst: false` because a person pressing a
      // button is demanding a re-dial, and the probe-first flavour answers a
      // live-but-stuck socket with nothing.
      onWakeTransport: () => {
        wsStreamClient.reconnectAll(EPIC_SESSION_WAKE_REASON, {
          probeFirst: false,
          wakeProbe: null,
        });
      },
      runtime: {
        port: runtimeWorker.port,
        command: (command) => {
          runtimeWorker.command(command);
        },
        awarenessOut: (docKey, frame, localClientId) => {
          runtimeWorker.awarenessOut(docKey, frame, localClientId);
        },
        currentUser: (nextUserId) => {
          runtimeWorker.currentUser(nextUserId);
        },
        detach: () => {
          runtimeWorker.detach();
        },
        dispose: () => {
          runtimeWorker.dispose();
        },
      },
    });
    projection.attach(created.projection);
    bodyTarget = created.body;

    /**
     * The UNAUTHORIZED revalidate, delivered by the PROJECTION rather than by a
     * callback.
     *
     * `onAuthError` fired from the control replica, which is worker-side now.
     * Its own comment says what it is: "The stream owns UNAUTHORIZED recovery
     * now: it stays 'reconnecting' and self-revalidates … keep the revalidate
     * as the sign-out cascade's NET (single-flight, a no-op once already
     * settled)." A net whose trigger is single-flight and idempotent does not
     * need callback timing, and the same branch that called it publishes
     * `snapshotFetchError` one line above - so the fact already crosses.
     *
     * Filtered on the CODE. All three branches of that handler publish a
     * snapshot error; only UNAUTHORIZED is the sign-out cascade's business, and
     * triggering a revalidate on an INCOMPATIBLE close would be a second bug
     * wearing this one's clothes.
     */
    // Not unsubscribed explicitly: the subscription's lifetime IS this store's,
    // and the store is what the registry disposes. An unsubscribe held here
    // would be a second lifetime to keep in step with the first.
    let revalidatedForUnauthorized = false;
    created.store.subscribe((state) => {
      if (state.snapshotFetchError?.code !== "UNAUTHORIZED") {
        // Re-armed once the error clears, so a later UNAUTHORIZED after a
        // recovery still reaches the net.
        revalidatedForUnauthorized = false;
        return;
      }
      // The projection republishes on every publish, not only on change, so
      // without this the single-flight would be asked once per slice.
      if (revalidatedForUnauthorized) return;
      revalidatedForUnauthorized = true;
      spec.onAuthError();
    });
    const noteSessionHealth = (state: OpenEpicState): void => {
      if (!state.snapshotLoaded || state.hostTransportStatus !== "open") {
        return;
      }
      // Only a loaded replica on an open transport proves that a previous plan
      // denial ended. A construction or a transient `connecting` projection
      // must not reset the ladder.
      spec.markHealthy();
    };
    detachSessionHealthy = created.store.subscribe(noteSessionHealth);
    noteSessionHealth(created.store.getState());

    // Construction-honest stamp, written exactly once: the transport above was
    // opened with this run's `hostId`, so the stamp IS the handle's transport
    // binding. Nothing re-stamps a live handle - a label that can drift from
    // the binding routes RPCs and capability answers to a host that does not
    // own the stream (F1).
    // The transport outlives every client on it, so the two lifetimes that end
    // the session have to close it: dispose (the registry evicting) and
    // detachTransport (a retained-dirty buffer that must stop dialling a host
    // this window has left). Composed here rather than inside the store because
    // the transport is this module's to own - the store knows about clients,
    // not sockets - and idempotently, so either path may run first or both may
    // run.
    const handle: OpenEpicStoreHandle = {
      ...created,
      dispose: () => {
        created.dispose();
        closeSessionTransport("tab-close");
      },
      detachTransport: () => {
        created.detachTransport();
        closeSessionTransport("repoint");
      },
    };
    // Stamped on the handle that ESCAPES, not on the inner store object:
    // `handleHostIds` is keyed by identity, and stamping `created` while
    // returning a wrapper leaves every lookup answering "no construction host
    // stamp" - which is a thrown invariant, not a silent miss, because the
    // stamp is what routes RPCs and capability answers to the host that owns
    // the stream (F1).
    handleHostIds.set(handle, hostId);
    // Stamped on the SAME escaping handle and for the same reason: this is the
    // socket the failure card's Retry silence gate asks, and it must travel
    // with the session rather than with the provider that happened to build it
    // - a warm remount and an adopted sibling both reach this handle and
    // neither re-runs this factory. Removed by `closeSessionTransport`.
    handleStreamClients.set(handle, wsStreamClient);
    streamStampedHandle = handle;
    // Armed now that there is something to rebuild. `retryTransport` is the
    // handle's, not `created`'s: the wrapper is what owns this session's
    // transport close, and a reprobe that rebuilt the inner store would leave
    // the socket behind.
    reprobeHandle = handle;
    // The same cell the fatal relay above writes, so a death that happened
    // before this line is already recorded on the handle the moment it exists.
    trackEpicSessionHandleLiveness(handle, liveness);
    trackEpicSessionTransportCloseAttribution(handle, (trigger) => {
      // The call site with the most specific product intent runs before the
      // registry's generic disposal mapping. First-wins preserves it through
      // the later onBeforeDispose callback.
      if (pendingTransportCloseTrigger === null) {
        pendingTransportCloseTrigger = trigger;
      }
    });
    return handle;
  } catch (error: unknown) {
    // Idempotent, and the handle's own paths are too, so a later `dispose` on a
    // handle that never escaped cannot double-close.
    closeSessionTransport("construction-failed");
    throw error;
  }
}
