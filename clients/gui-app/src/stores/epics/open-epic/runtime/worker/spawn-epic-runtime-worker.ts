/**
 * Starting the runtime worker from the main thread, and everything that has to
 * be true the moment it exists.
 *
 * Four jobs, in order, because each depends on the previous one:
 *
 *  1. construct the worker and put a typed endpoint over it;
 *  2. build the stream proxy host over the session's REAL stream client, so
 *     the worker's `IStreamClient` has something behind it;
 *  3. hand it the bootstrap it validates its protocol against;
 *  4. relay what comes back - logs, a fatal, projections, and the proxy's own
 *     traffic.
 *
 * The socket is NOT among those jobs, and that is the design rather than an
 * omission: the durable transport stays exactly where it is, because
 * `buildHostStreamClient`'s remote branch reaches a module-scoped process-wide
 * `RemoteSession` cache and a worker copy of it is a second Noise session and
 * relay socket per (hostId, userId). What moves is the four typed wrappers and
 * their decode - see `stream-proxy-protocol.ts`.
 *
 * The worker constructor is INJECTED rather than called here. That is what
 * lets the suites drive a real endpoint over a fake worker; it is also what
 * keeps `new Worker(...)` out of every module a test imports, since jsdom has
 * no `Worker` at all.
 */
import type { IStreamClient } from "@traycer-clients/shared/host-transport/i-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  createMainBridgeEndpoint,
  type MainCallHandlers,
  type RuntimeWorkerPort,
} from "@traycer-clients/shared/replica-runtime/worker/bridge-endpoint";
import {
  createStreamProxyHost,
  type StreamProxyHost,
} from "@traycer-clients/shared/replica-runtime/worker/stream-proxy-host";
import {
  createRuntimeProjectionOrdering,
  type RuntimeProjectionHandlers,
} from "@traycer-clients/shared/replica-runtime/worker/runtime-projection-subscription";
import {
  createMessageTargetTransport,
  type BridgeMessageTargetLike,
} from "@traycer-clients/shared/replica-runtime/worker/bridge-transports";
import {
  RUNTIME_BRIDGE_PROTOCOL_VERSION,
  type LaneUnaryOutcome,
  type LaneUnaryRequest,
  type WriteCommandOutcome,
  type RuntimeWorkerLogEntry,
  type RuntimeCommand,
  type WorkerToMainEvent,
  isStreamProxyEvent,
} from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import type { StreamMethodSupportSource } from "@traycer-clients/shared/host-transport/host-stream-client";
import { subscribeNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { EPIC_LANE_METHODS } from "@traycer-clients/shared/epic-lanes";
import { readEpicDocRecordArms } from "@/stores/epics/open-epic/doc-record-arms";
import {
  NO_TRANSFER,
  takeBytesForTransfer,
} from "@traycer-clients/shared/replica-runtime/worker/transferable-bytes";
import { createMainAccountingBridge } from "./main-accounting-bridge";
import type { EpicRuntimeAccountingPort } from "../epic-runtime-accounting-port";

/** The part of `Worker` this module uses. */
export interface RuntimeWorkerLike extends BridgeMessageTargetLike {
  terminate(): void;
  /**
   * Subscribes to the faults a worker reports as EVENTS rather than as bridge
   * messages.
   *
   * A separate member, and REQUIRED, because the bridge cannot carry this
   * class of failure by construction. `new Worker(url, {type:"module"})`
   * returns synchronously; if that module then fails to fetch, parse or
   * evaluate, the thread never runs a line of our code - so it emits no
   * `ready` and no `fatal`, and a handle that listens only for bridge
   * messages waits forever. Production does not await {@link
   * EpicRuntimeWorkerHandle.ready}, so the session is already presented as
   * ready by then and the epic spins on a snapshot that can never arrive,
   * with no Retry offered.
   *
   * Not folded into `addEventListener`: {@link BridgeMessageTargetLike} pins
   * that member's type parameter to `"message"`, and an overload cannot be
   * added by an extending interface. Not a probed capability either - every
   * implementor HAS an `addEventListener`, so no structural guard can tell
   * one that handles `"error"` from one that does not, and a silent `false`
   * is the failure this member exists to end.
   *
   * A no-op subscription is the right answer for an in-thread fake, whose
   * module cannot fail to load. Stating that per fake is the point: it is
   * the difference between a harness that CANNOT reach this path and one
   * that merely does not.
   *
   * No unsubscribe, unlike the `message` pair above, because there is no
   * point in this handle's life at which it would stop caring: the
   * subscription lasts as long as the handle, and `terminate()` ends the
   * event source itself.
   */
  onWorkerFault(listener: (message: string) => void): void;
}

/**
 * The CLOSED method set a replicated manifest names.
 *
 * The four stream methods an epic runtime can open, and nothing else. The
 * manifest is a replica of main's negotiation, not a copy of it: the worker's
 * lookup answers `"unknown"` / `null` for anything absent, which is the same
 * answer a relay connection gives forever and which selection already treats as
 * "not a selection". So a method the worker never opens costs a wire entry and
 * buys nothing.
 *
 * `epic.subscribe` is in the set even though it is the arm being retired -
 * the legacy arm is still selectable, and a manifest that named only the lanes
 * would replicate a negotiation the legacy adapter cannot read its own version
 * off.
 *
 * Derived from `EPIC_LANE_METHODS` rather than restating those three, so a
 * fourth lane added there arrives here without a second list to remember.
 */
const EPIC_MANIFEST_METHODS: readonly (keyof HostStreamRpcRegistry & string)[] =
  ["epic.subscribe", ...EPIC_LANE_METHODS];

/**
 * Where a worker's log lines and its fatal go.
 *
 * A sink rather than a direct `appLogger` import, so this module stays
 * constructible in a suite and so the relay's own behaviour (a fatal is not
 * just another log line) is visible at the call site.
 */
export interface RuntimeWorkerLogRelay {
  log(entry: RuntimeWorkerLogEntry): void;
  fatal(message: string, stack: string | null): void;
}

/**
 * Where the body plane's RETURN leg lands.
 *
 * Named and exported because two modules must agree on it and neither owns
 * both ends: the spawner RECEIVES it, and the store PROVIDES it (it is the
 * store that holds the live docs). A structural copy on each side would let
 * one drift without the other noticing - the same reason `projection` is a
 * named contract rather than an inline shape.
 */
export interface EpicRuntimeBodyReturnTarget {
  applyDocUpdate(docKey: string, update: Uint8Array): void;
  applyAwareness(docKey: string, frame: Uint8Array): void;
}

export interface SpawnEpicRuntimeWorkerOptions<TProjection> {
  readonly createWorker: () => RuntimeWorkerLike;
  /**
   * Where a worker's log lines and its fatal go. A fatal is NOT just another
   * log line: the runtime behind the bridge is gone, so a UI waiting on
   * projections must be told rather than left waiting.
   */
  readonly relay: RuntimeWorkerLogRelay;
  /**
   * Sends one epic write command on this session's unary requester, and
   * CLASSIFIES its failure here on the main thread.
   *
   * Classification is main's because an `Error` does not survive structured
   * clone: the worker must receive `CommandSendFailure` - the classifier's own
   * union - never a thrown object it would have to reconstruct. The worker's
   * command queue then re-throws it as a carrier and unwraps it in its own
   * `classifyFailure`, which leaves the SHARED `CommandQueueOptions` contract
   * untouched.
   */
  readonly writeCommand: (
    commandId: string,
    intent: unknown,
  ) => Promise<WriteCommandOutcome>;
  /**
   * Issues one lane unary on this session's requester, and reduces its failure
   * to a clonable value HERE, on the main thread - the same rule
   * {@link writeCommand} states, for the same reason.
   */
  readonly laneUnary: (request: LaneUnaryRequest) => Promise<LaneUnaryOutcome>;
  /**
   * This connection's negotiated per-method support, and a notification when it
   * moves.
   *
   * SEPARATE from {@link streams} even though production passes one object for
   * both, and narrow (`StreamMethodSupportSource`) rather than the whole
   * client. Two reasons, and neither is style. `streams` is typed
   * `IStreamClient` because that is all the proxy host relays frames over -
   * widening it would drag `isReady` and `subscribeAvailabilityRecovered` onto
   * every fake a suite hands this spawner, for members nothing here reads. And
   * the two are used at opposite ends: `streams` is the thing PROXIED, this is
   * the thing the manifest is BUILT from.
   */
  readonly methodSupport: StreamMethodSupportSource<HostStreamRpcRegistry>;
  /**
   * The session's REAL stream client, which stays on this thread.
   *
   * The worker gets a proxy over it, never the thing itself: the durable
   * transport underneath reaches a module-scoped process-wide `RemoteSession`
   * cache, so a second copy in a worker is a second Noise session and relay
   * socket per (hostId, userId).
   */
  readonly streams: IStreamClient<HostStreamRpcRegistry>;
  /** Identifies this renderer window in the worker's log lines. */
  /**
   * What to do with published projection slices.
   *
   * Handlers rather than a raw callback, because the spawner constructs the
   * ONE reducer that orders them. Handing a caller `(revision, value)` would
   * let it build a second reducer with a second watermark over the same
   * stream, and two watermarks drop each other's deliveries as stale - a
   * projection that updates half the time. The spawner still does not NARROW:
   * `accept` is the caller's, because the slice's shape is the store's.
   */
  readonly projection: RuntimeProjectionHandlers<TProjection>;
  /**
   * The process-backed books this worker's runtime reports into.
   *
   * Built by the CALLER on main, exactly as the in-process store builds it, so
   * both arms draw their runtime token from the one process-wide sequence.
   * Nothing about it crosses the bridge - the worker pushes byte facts in the
   * runtime's own vocabulary and this side names the holders.
   */
  /**
   * A collaborator's edit and a remote presence frame, both for the live doc
   * main holds. See {@link EpicRuntimeBodyReturnTarget} for who provides it.
   *
   * An unknown `docKey` is dropped by the implementation, silently - presence
   * and edits for a body main is not holding have nowhere to go, and there is
   * no answer a fire-and-forget sender could act on.
   */
  readonly body: EpicRuntimeBodyReturnTarget;
  readonly accounting: EpicRuntimeAccountingPort;
  /** The epic this worker serves for its whole life. */
  readonly epicId: string;
  /**
   * The host this session is bound to, for its whole life.
   *
   * Rides the bootstrap because the write-command send gate reads it - see
   * `RuntimeWorkerBootstrap.hostId`, which names that reader and the defect
   * its absence caused.
   */
  readonly hostId: string;
  readonly windowLabel: string;
}

export interface EpicRuntimeWorkerHandle {
  /**
   * The ask half of the bridge - `call` and nothing else.
   *
   * Deliberately NOT the endpoint. Handing out `onEvent` would let a caller
   * subscribe a second projection reducer beside the one this spawner owns,
   * which is the two-watermark defect; a narrower type makes that unreachable
   * instead of merely discouraged.
   */
  readonly port: RuntimeWorkerPort;
  /**
   * Resolves when the worker has acknowledged the bootstrap, and rejects if it
   * reported a protocol mismatch instead.
   *
   * A promise rather than a flag because every caller has to decide what to do
   * about a worker that never answered, and a flag lets that decision be
   * skipped by accident.
   */
  readonly ready: Promise<void>;
  /**
   * Ends the TRANSPORT while the worker lives on - path 2 (`detachTransport`),
   * where a retained-dirty buffer must stop dialling a host this window has
   * left but keeps its replica. Every real session is reported closed to the
   * worker first. Idempotent.
   *
   * Must run BEFORE `closeSessionTransport()` at the call site: closing the
   * transport first kills the sessions before they can be reported.
   */
  /**
   * Send one fire-and-forget command to the relocated runtime.
   *
   * Narrow on purpose, like `port`: this is the ONE way to push a
   * `runtime/command`, so a caller cannot reach `emit` and publish something
   * else on the same channel. Ordering across these and the stream frames is
   * `postMessage` FIFO - see `RuntimeCommandMap`.
   */
  command(command: RuntimeCommand): void;
  /**
   * Send a local presence frame for one body.
   *
   * Its own member rather than a `runtime/command` payload: presence is not a
   * runtime COMMAND, it is a frame for the arm, and folding it in would put a
   * per-keystroke-rate channel through a vocabulary whose members are user
   * gestures and record pushes.
   */
  awarenessOut(docKey: string, frame: Uint8Array, localClientId: number): void;
  /**
   * Tell the worker who is signed in.
   *
   * The worker's projector folds on `getCurrentUserId()`, which is fed by this
   * event and by nothing else - and until now NOTHING EMITTED IT. The protocol
   * declared the event and the worker host handled it; the producer was simply
   * never written, so the fold ran with a null user for the whole session and
   * a null user is the fail-OPEN direction: foreign chats and terminal agents
   * are not hidden, and same-account role claims do not project.
   *
   * Pushed rather than answered on demand, because the worker needs it before
   * its first projection and identity arrives on main's own schedule (the auth
   * profile hydrates after the session is constructed).
   */
  currentUser(userId: string | null): void;
  detach(): void;
  /**
   * Idempotent. Detaches (so the worker observes every close), then asks the
   * worker to stop and terminates it. Paths 1, 3, 4 and 5.
   */
  dispose(): void;
}

export function spawnEpicRuntimeWorker<TProjection>(
  options: SpawnEpicRuntimeWorkerOptions<TProjection>,
): EpicRuntimeWorkerHandle {
  const worker = options.createWorker();
  // Built from what the caller holds. Both worker->main calls, answered by the
  // session's own requester - see `MainCallMap` for why they are calls.
  const mainCallHandlers: MainCallHandlers = {
    "main/write-command": (request) =>
      options.writeCommand(request.commandId, request.intent),
    "main/lane-unary": (request) => options.laneUnary(request),
  };
  const bridge = createMainBridgeEndpoint(
    createMessageTargetTransport(worker),
    mainCallHandlers,
  );
  // The proxy host owns the REAL sessions the worker opens. It is the object
  // this side detaches, not the socket.
  //
  // A SLOT rather than a constant only because `detach()` clears it. There used
  // to be an `attach(streams)` beside it that re-bound a fresh proxy over a new
  // transport, and this comment justified the slot by that re-attach - but the
  // member had no callers and could not have worked: it re-detached (emitting a
  // second detach-transport) and installed a main-side proxy the worker never
  // reopens through, leaving the worker detached with no sessions. Production
  // rebinding is a RESPAWN - the retained handle merges into a new session - so
  // the member was deleted rather than completed.
  const buildProxy = (
    streams: IStreamClient<HostStreamRpcRegistry>,
  ): StreamProxyHost =>
    createStreamProxyHost(
      streams,
      (event, transfer) => {
        bridge.emit(event, transfer);
      },
      (reason) => {
        options.relay.log({
          level: "error",
          message: `[epic-runtime-worker] ${reason}`,
          fields: { windowLabel: options.windowLabel },
          error: null,
        });
      },
    );
  let proxy: StreamProxyHost | null = buildProxy(options.streams);

  let settleReady: (() => void) | null = null;
  let failReady: ((cause: Error) => void) | null = null;
  const ready = new Promise<void>((resolve, reject) => {
    settleReady = resolve;
    failReady = reject;
  });
  // A caller may legitimately never await `ready` - a surface that only wants
  // projections has nothing to do about a slow handshake. Attaching a handler
  // here keeps that from becoming an unhandled rejection on dispose, while
  // leaving the rejection visible to anyone who does await.
  void ready.catch(() => undefined);

  // The one reducer for this worker's projection stream, constructed here so
  // there can be no second one.
  const projections = createRuntimeProjectionOrdering(options.projection);

  // Turns the worker's byte pushes back into calls on the real books, and
  // answers the accountant's synchronous reads from the snapshot each push
  // carries. The demote it dispatches is the one inbound member.
  const accounting = createMainAccountingBridge({
    port: options.accounting,
    dispatchDemote: (overBytes) => {
      bridge.emit({ kind: "accounting/demote", overBytes }, NO_TRANSFER);
    },
  });

  /**
   * The ONE way a dead runtime is surfaced, reached from both entries: the
   * worker's own `fatal` bridge event, and a fault the worker reports as a DOM
   * event because no code of ours is running to send one.
   *
   * Shared rather than duplicated because the three steps are not
   * independent, and a second copy would drift on whichever one a later
   * reader thought was the incidental part.
   */
  /**
   * Whether construction has reached the point where `disposeHandle` can run.
   *
   * A fatal can arrive DURING construction, and `disposeHandle` reads bindings
   * declared well below this line - `disposed`, and the three unsubscribes -
   * so calling it early would hit their temporal dead zone and throw a
   * `ReferenceError` from the constructor, replacing the failed presentation
   * and the rejected `ready` with a crash. Two ways in, not one:
   *
   *  - `worker.onWorkerFault` is subscribed above the bootstrap on purpose,
   *    because a module that fails to evaluate can have faulted already, and
   *    nothing in `RuntimeWorkerLike` forbids an implementation that replays
   *    that fault synchronously on subscribe;
   *  - the bridge's own `fatal` event, which a synchronous in-process bridge
   *    can deliver from inside the `bootstrap` emit below.
   *
   * Deferring rather than reordering the subscriptions: the fatal's VISIBLE
   * half - the relay call and the `ready` rejection - still runs immediately
   * and in the same order, and every subscription that gets created still gets
   * torn down, which moving the teardown earlier could not promise.
   *
   * An OBJECT rather than two `let` booleans, and not as a style choice:
   * `surfaceFatal` assigns them from inside a closure, which TypeScript's
   * control-flow analysis does not model, so a plain `let x = false` stays
   * narrowed to `false` at the discharge site below and
   * `no-unnecessary-condition` rejects reading it. Property narrowing is
   * invalidated by the intervening calls, so this reads honestly.
   */
  const fatalTeardown = { constructionComplete: false, deferred: false };

  const surfaceFatal = (message: string, stack: string | null): void => {
    // The runtime behind the bridge is gone, so its books must not stay
    // attached to the process planes. Without this the accountant keeps a
    // dead runtime's cached numbers and dispatches demote requests into a
    // bridge nothing is listening on - a plane that never reclaims and never
    // explains why. Idempotent, so the `dispose()` below is not a second
    // deregistration.
    accounting.dispose();
    options.relay.fatal(message, stack);
    // A fatal before the handshake is the handshake's answer. After it, the
    // promise has already settled and this is a no-op - the relay is what
    // surfaces a mid-life fatal.
    //
    // BEFORE the teardown below, and that order is load-bearing: `dispose()`
    // rejects an unsettled `ready` with its own "disposed before it was
    // ready", so tearing down first would replace the cause with the
    // consequence and hand every awaiter the wrong reason.
    failReady?.(new Error(message));
    // AND RELEASE THE TRANSPORT. Until this, the fatal path freed the books
    // and presented Retry while `proxy` kept every real `IStreamSession` the
    // worker had opened - so a user who neither retried nor reopened the epic
    // left host subscriptions live indefinitely, forwarding frames toward a
    // bridge nothing reads. Nothing else collected them: the provider marks
    // the handle dead rather than disposing it (registry mutation belongs to
    // the acquire effect), and that pass only runs if the user comes back.
    // Cap-eviction cannot stand in either: the registry only evicts an
    // UNMOUNTED entry the cap has pushed past, and a fatal can land on a
    // mounted one, under the cap, with a frozen state that reads dirty.
    //
    // Through `dispose()` rather than a fatal-only teardown, for the reason
    // `dispose()` itself gives about `detach()`: a second copy of the
    // close-then-teardown ordering is what got it wrong the first time. It is
    // idempotent, it is safe from inside a bridge event (the dispatch
    // iterates a COPY of the listener set precisely so a listener may
    // unsubscribe during it), and it touches no registry - this is the
    // runtime worker handle, one level below the session handle the provider
    // is talking about.
    //
    // Deferred when the fatal beat construction to it - see `fatalTeardown`.
    // The phase is read, not the clock: a fatal on the very first tick and one
    // an hour later take the same path.
    if (fatalTeardown.constructionComplete) {
      disposeHandle();
      return;
    }
    fatalTeardown.deferred = true;
  };

  // The failure the bridge cannot carry. Subscribed BEFORE the bootstrap is
  // emitted below, because a module that fails to evaluate can have already
  // faulted by the time this handle finishes constructing. An implementation
  // that answers that by replaying the fault synchronously right here is
  // exactly what `fatalTeardown` above exists to survive.
  worker.onWorkerFault((message) => {
    // No stack: this arrives as a DOM `ErrorEvent`, whose `error` is `null`
    // for a module that never evaluated, and the worker had no chance to
    // build one of its own. `null` is the honest answer, and the same one the
    // relay already accepts from a stackless bridge fatal.
    surfaceFatal(message, null);
  });

  const unsubscribeEvents = bridge.onEvent((event: WorkerToMainEvent) => {
    // The stream-proxy family, recognised as ONE thing, and peeled here rather
    // than given five labels in the switch below: `complexity` counts case
    // labels, and five sharing a one-line body pushed this dispatch over the
    // cap while adding no decision a reader has to follow.
    //
    // The predicate is IMPORTED rather than declared here, and that is the
    // whole point of this peel now: it is the same rule the proxy host's
    // parameter type states, so the two cannot disagree. It used to live here
    // as a local `Extract`, which meant main decided the family by prefix while
    // the host decided it by five case labels plus a `default` that swallowed
    // everything else - two lists, one of them checked.
    if (isStreamProxyEvent(event)) {
      // Every unknown id is dropped inside the host, silently and on purpose:
      // a frame can be in flight when a session closes, and a throw here is an
      // unhandled error in a `message` listener with no route back.
      proxy?.handle(event);
      return;
    }
    switch (event.kind) {
      case "ready":
        settleReady?.();
        return;
      case "log":
        options.relay.log(event.entry);
        return;
      case "projection":
        projections.deliver(event.revision, event.value);
        return;

      case "body/doc-in":
        // The return leg. Main stamps these with its own private origin on
        // apply, which is what stops its observer sending them straight back.
        options.body.applyDocUpdate(event.docKey, event.update);
        return;
      case "body/awareness-in":
        options.body.applyAwareness(event.docKey, event.frame);
        return;
      case "accounting/books":
      case "accounting/settle":
        accounting.handle(event);
        return;
      case "fatal":
        surfaceFatal(event.message, event.stack);
        return;
      default:
        assertNever(event);
    }
  });

  bridge.emit(
    {
      kind: "bootstrap",
      bootstrap: {
        protocolVersion: RUNTIME_BRIDGE_PROTOCOL_VERSION,
        epicId: options.epicId,
        hostId: options.hostId,
        windowLabel: options.windowLabel,
      },
    },
    NO_TRANSFER,
  );

  /**
   * The negotiated manifest, replicated into the worker so it can SELECT an
   * arm at all.
   *
   * The protocol declared `stream/manifest` and the worker host consumed it;
   * nothing on this side ever emitted one. The consequence is not a missing
   * optimisation: `support(method)` answers `"unknown"` for every method
   * against a manifest that is `null` forever, `"unknown"` is deliberately not
   * a selection, and the fail-closed default is the legacy `@1` arm. So a
   * worker-hosted runtime held legacy for its entire life on every host,
   * including one that serves the lanes - the cutover's whole subject, absent,
   * with a working epic as the symptom. The initial capability PROBE masks part
   * of it (the status lane's own subscribe settles the verdict for a
   * connection), which is precisely why it went unnoticed; what the probe
   * cannot do is move a tab whose host upgraded underneath it, because that
   * signal only exists in the manifest.
   *
   * `docArm` is read here rather than pushed by a caller because it is a MAIN
   * fact - `readEpicDocRecordArms` consults the ambient negotiated-manifest
   * registry. Bundling the three into one event is the protocol's own rule, so
   * that a worker can never read a support verdict from one negotiation beside
   * a doc arm from another.
   *
   * ## TWO subscriptions, because the three fields have two sources
   *
   * `methodSupport` is the STREAM client's learned support; `docArm` comes off
   * the negotiated-UNARY manifest registry. This used to subscribe only to the
   * first, on the reasoning that one edge moves both - true of a reconnect that
   * re-handshakes, and false of the first unary handshake completing after this
   * worker was spawned. That is not a rare interleaving: it is the ordinary
   * order on a warm tab, and it left the worker holding the fail-closed
   * `docArm` against a host that serves the record-list methods. The GUI then
   * asks for the doc remainder with `hasDocReplica: false` while the worker
   * still unions a live root row with a poll row, and because the record side
   * wins, a newer rename or reparent stays hidden behind the older poll value
   * until some later list response dislodges it.
   *
   * The registry subscription earns its keep a second time, on the arm
   * selection. `RemoteStreamClient.subscribeMethodSupport` is a no-op and its
   * `getMethodSupport` is `"unknown"` forever, so over a relay the first
   * subscription produces NO edge at all - not a late one. The registry is
   * written on every session re-attach (`remote-session.ts`), which makes this
   * the only signal that reaches a worker-hosted runtime when a remote host is
   * upgraded underneath an open tab. See `applySelection`'s re-probe.
   *
   * It fires for any host's change, not just this one's, and re-emitting an
   * unchanged manifest is deliberately not filtered: the worker's own
   * `applySelection` is documented idempotent and cheap, and an equality check
   * here would be a second place that can decide two manifests are the same -
   * the failure of getting THAT wrong is a verdict that never arrives.
   */
  let disposed = false;

  function emitManifest(): void {
    if (disposed) return;
    bridge.emit(
      {
        kind: "stream/manifest",
        manifest: {
          methodVersions: EPIC_MANIFEST_METHODS.map((method) => ({
            method,
            version: options.streams.getMethodSchemaVersion(method),
          })),
          methodSupport: EPIC_MANIFEST_METHODS.map((method) => ({
            method,
            support: options.methodSupport.getMethodSupport(method),
          })),
          docArm: readEpicDocRecordArms(options.hostId),
        },
      },
      NO_TRANSFER,
    );
  }

  // ONCE before any change, because `subscribeMethodSupport` reports movement
  // and not state: a connection whose handshake resolved before this worker was
  // spawned - a second tab on a warm transport - would otherwise wait for an
  // edge that has already happened.
  emitManifest();
  const unsubscribeMethodSupport =
    options.methodSupport.subscribeMethodSupport(emitManifest);
  const unsubscribeNegotiatedManifests =
    subscribeNegotiatedManifests(emitManifest);

  function detach(): void {
    // The WORKER first, before main's proxy goes away.
    //
    // Ending the transport is a fact the worker has to act on - it unbinds the
    // projector, drops landed overlay entries, and publishes the
    // transport-detached control state the UI renders. None of that happened
    // while this function only tore down main's side, which is what left a
    // detached session still reporting itself connected.
    //
    // Posted BEFORE the proxy is disposed, deliberately: closing the worker's
    // sockets can emit frames back through the proxy, and the proxy's
    // documented silent-drop tolerance ("a frame can be in flight when a
    // session closes") is what covers whatever arrives after it goes. Reverse
    // the order and those close reports have nowhere to land.
    if (!disposed) {
      bridge.emit(
        {
          kind: "runtime/command",
          command: { kind: "detach-transport", payload: {} },
        },
        NO_TRANSFER,
      );
    }
    const detaching = proxy;
    proxy = null;
    // While the bridge is still LIVE and its events still routed. Every real
    // session gets its `closed` + `caller` report on the way out, and the
    // worker's adapters run their close handling instead of watching a stream
    // go quiet - which is indistinguishable from a slow host.
    //
    // This ordering was wrong once, in exactly the way that is invisible: the
    // teardown ran first, so the reports were posted into a disposed bridge
    // and dropped, and the pin missed it because it drove the proxy host
    // directly rather than this handle.
    detaching?.dispose();
  }

  // A hoisted declaration rather than a method on the object below, because
  // `surfaceFatal` calls it and is defined earlier: the fatal path now
  // releases the transport, not just the books.
  function disposeHandle(): void {
    if (disposed) return;
    disposed = true;
    // Detach FIRST, and through the same function the detach-only path uses -
    // one copy of the close-then-teardown ordering, because a second copy is
    // what got it wrong the first time.
    detach();
    // Only then stop routing. Unsubscribing before the detach drops every
    // report even on a live bridge.
    unsubscribeEvents();
    // The transport outlives this worker on the retained-buffer path, so a
    // manifest listener left behind would emit onto a disposed bridge every
    // time that connection re-handshakes. BOTH of them: the registry is
    // module-scoped and process-wide, so a listener leaked there outlives not
    // just the transport but every session on it.
    unsubscribeMethodSupport();
    unsubscribeNegotiatedManifests();
    // The worker will not get to say `accounting/books registered: false` -
    // it is about to be terminated - so main releases the holders itself.
    accounting.dispose();
    // Ask before killing. `shutdown` lets the worker dispose its own core -
    // a durable store mid-write, a transport mid-close - whereas
    // `terminate()` stops it between two machine instructions.
    bridge.emit({ kind: "shutdown" }, NO_TRANSFER);
    bridge.dispose();
    // Nothing waits on the shutdown being observed: a worker that stopped
    // answering is exactly the case `terminate()` is for, and holding the
    // window open on it would make disposal depend on the health of the
    // thing being disposed.
    worker.terminate();
    // A never-settled `ready` outlives the handle otherwise, and its awaiter
    // hangs on a worker that no longer exists. A no-op when a fatal already
    // rejected it with the real cause.
    failReady?.(
      new Error("The epic runtime worker was disposed before it was ready"),
    );
  }

  // Everything `disposeHandle` touches now exists, so the deferral above can
  // be discharged. Before the `return`, deliberately: the caller is handed an
  // already-disposed handle whose `ready` is already rejected with the real
  // cause, rather than a live-looking one over a worker that is going away.
  fatalTeardown.constructionComplete = true;
  if (fatalTeardown.deferred) {
    disposeHandle();
  }

  return {
    port: bridge,
    ready,
    currentUser(userId): void {
      if (disposed) return;
      bridge.emit({ kind: "current-user", userId }, NO_TRANSFER);
    },
    awarenessOut(docKey, frame, localClientId): void {
      if (disposed) return;
      const encoded = takeBytesForTransfer(frame);
      bridge.emit(
        {
          kind: "body/awareness-out",
          docKey,
          frame: encoded.bytes,
          localClientId,
        },
        encoded.transfer,
      );
    },
    command(command): void {
      if (disposed) return;
      bridge.emit({ kind: "runtime/command", command }, NO_TRANSFER);
    },
    detach,
    dispose: disposeHandle,
  };
}

/**
 * The production worker.
 *
 * The literal form matters and is not stylistic: Vite recognises a worker only
 * when `new URL(<static string>, import.meta.url)` appears DIRECTLY inside
 * `new Worker(...)`. A URL built in a variable first, or a template with an
 * interpolation, compiles fine and resolves at runtime to a path that does not
 * exist in the bundle. Both bundles that build this app (the desktop
 * renderer's `vite.renderer.config.ts` and mobile's `vite.config.ts`) rely on
 * that same recognition, so the shape has to survive edits in both.
 *
 * `type: "module"` is carried through to the constructed worker verbatim -
 * Vite rewrites the URL and leaves the options alone - and the emitted worker
 * is a same-origin asset file, never a `blob:` or `data:` URL. That is what
 * makes this work under the desktop's CSP unchanged: the policy has no
 * `worker-src`, so a worker falls back to `script-src 'self'`, and the
 * renderer's own origin (`app://renderer/`, a standard secure scheme) covers
 * it. An inline worker (`?worker&inline`) is the form that would need a policy
 * line, and this is deliberately not it.
 */
export function createEpicRuntimeWorker(): RuntimeWorkerLike {
  const worker = new Worker(
    new URL("./epic-runtime-worker-entry.ts", import.meta.url),
    {
      type: "module",
      name: "traycer-epic-runtime",
    },
  );
  // Forwarded rather than returned directly, and this is the ONE place the
  // DOM-event shape of a worker fault is known. Both events land on the same
  // listener because both mean the same thing to the spawner - no further
  // bridge traffic is coming:
  //
  //   `error`        - the module failed to fetch, parse or evaluate, or a
  //                    top-level throw escaped it. `event.message` is empty
  //                    for a cross-origin script, hence the fallback.
  //   `messageerror` - the worker sent something this thread cannot
  //                    deserialize. It carries no message at all, and a bridge
  //                    that has started dropping frames is not a bridge a
  //                    session can wait on.
  return {
    postMessage: (message, transfer) => {
      worker.postMessage(message, transfer);
    },
    addEventListener: (type, listener) => {
      worker.addEventListener(type, listener);
    },
    removeEventListener: (type, listener) => {
      worker.removeEventListener(type, listener);
    },
    terminate: () => {
      worker.terminate();
    },
    onWorkerFault: (listener) => {
      worker.addEventListener("error", (event) => {
        listener(
          event.message === ""
            ? "the epic runtime worker module failed to load"
            : event.message,
        );
      });
      worker.addEventListener("messageerror", () => {
        listener("the epic runtime worker sent an undeserializable message");
      });
    },
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled runtime worker event ${JSON.stringify(value)}`);
}
