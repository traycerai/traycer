/**
 * An adapter decodes ONE wire lane into replica events and owns that lane's
 * stream lifecycle, generation guard, and resume cursor.
 *
 * Adapters are the only components in the runtime that know a wire exists. The
 * legacy `epic.subscribe@1` consumption and the decomposed lane subscriptions
 * implement the SAME interface - that is what makes the mixed fleet a
 * configuration rather than a fork, and it is what lets the worker relocation
 * move the legacy root `Y.Doc` off-thread too (it becomes an adapter-internal
 * detail, and no editor binds it).
 *
 * The rule that makes the runtime testable: an adapter emits events and never
 * touches a projection. The block being redesigned today does the opposite -
 * each of its thirty-odd callbacks applies bytes, sends a wire response,
 * mutates closure transport flags, AND writes UI state including modal and
 * editor-rebind signals, all in one function body. Untangling that into
 * decode-then-emit is the point of this interface.
 */
import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "../host-transport/i-stream-session";
import type { LaneId, ResumeOffer, ResumeOutcome } from "./lane-cursor";
import type {
  ReplicaReplacementReason,
  ReplicaTransitionToken,
} from "./replica";
import type { RuntimeEnvironment } from "./runtime-environment";

/**
 * Whether an adapter speaks the decomposed lanes or wraps a legacy surface.
 *
 * Recorded on the descriptor because it changes what the runtime may EXPECT,
 * not just what it logs: a legacy adapter cannot report seed trust, cannot
 * offer a resume cursor, and delivers a whole-epic snapshot where a lane
 * adapter delivers a typed one. Consumers that need to degrade gracefully read
 * this rather than sniffing behaviour.
 */
export type AdapterKind = "lane" | "legacy";

export interface AdapterDescriptor {
  readonly laneId: LaneId;
  readonly kind: AdapterKind;
  /**
   * Human-readable, for logs and the replay harness's failure messages. Not an
   * identity - {@link laneId} is.
   */
  readonly label: string;
}

/**
 * The adapter's view of its own connection.
 *
 * Reuses the transport's status vocabulary rather than minting a parallel one:
 * every adapter is ultimately driven by an `IStreamSession`, and two words for
 * `"reconnecting"` is how a UI ends up with two disagreeing indicators.
 */
export interface AdapterStatus {
  readonly connection: StreamConnectionStatus;
  /** Non-null only on a `"closed"` transition. */
  readonly closeReason: StreamCloseReason | null;
}

/**
 * What the runtime hands an adapter when it attaches.
 *
 * Every capability an adapter is allowed to use, and nothing else. In
 * particular there is no projection sink and no store handle here - an adapter
 * that could write UI state directly is the thing this seam exists to prevent.
 */
export interface AdapterHost<TEvent> {
  readonly environment: RuntimeEnvironment;

  /**
   * Deliver one decoded event. Synchronous; the runtime batches within a
   * projection transaction, so an adapter should emit a frame's worth of
   * events back-to-back and let the runtime decide when to project.
   */
  emit(event: TEvent): void;

  /**
   * Report an observed resume outcome. Distinct from `emit` because it is a
   * statement about the SUBSCRIPTION, not about the data - and because a
   * `"reseeded"` outcome must be visible to the runtime even when the snapshot
   * that follows is identical to what the replica already held.
   */
  reportResume(outcome: ResumeOutcome): void;

  reportStatus(status: AdapterStatus): void;

  /**
   * Ask the runtime to rebuild the replica this adapter feeds.
   *
   * The adapter detects the condition; the runtime decides and sequences. That
   * split is what makes a cross-lane migration expressible: the state lane
   * requests replacement while the control lane is still reporting progress,
   * and the runtime holds both until the post-migration epoch is known.
   */
  /**
   * Takes an authority reason, NOT the provenance-carrying `ReplicaResetCause`,
   * and the narrowing is deliberate: an adapter speaks for the authority by
   * construction, so it must not be able to originate a client-initiated
   * reseed. The runtime widens this to `{ origin: "authority", reason }` when
   * it drives the reset.
   */
  /**
   * `transition` names WHICH occurrence this is, so the runtime can collapse
   * the same one reported by two lanes without having to clear a guard between
   * genuine ones. Build it with the `*Transition` helpers in `replica.ts`;
   * see {@link ReplicaTransitionToken} for why the reason cannot do this job.
   */
  requestReplacement(
    reason: ReplicaReplacementReason,
    transition: ReplicaTransitionToken,
  ): void;
}

/**
 * Why an adapter is being detached.
 *
 * `"transport-only"` is the member with history. `detachTransport()` already
 * exists in the open-epic store - keep the replica, drop the socket - and it is
 * one of the two artifacts proving the runtime/adapter distinction was latent
 * in the code before anyone named it. A session retained across a host re-point
 * MUST stop dialling (a retained handle that keeps its stream client reports
 * dial evidence for a host the window has left, into the host-selection
 * authority's death detection) while keeping every unsynced edit addressable.
 */
export type AdapterDetachReason =
  /** Stop the socket, keep the replica and its unsynced state. */
  | "transport-only"
  /** The session is going away entirely. */
  | "disposed"
  /** A different adapter set is taking over this lane. */
  | "superseded";

export interface LaneAdapter<TEvent> {
  readonly descriptor: AdapterDescriptor;

  /**
   * Begin decoding into `host`. Called once per attachment; an adapter that has
   * been detached is not re-attached - the runtime builds a fresh one, so the
   * generation guard has exactly one owner.
   */
  attach(host: AdapterHost<TEvent>): void;

  /**
   * The cursor this adapter would offer on its next (re)subscribe.
   *
   * A pure, synchronous read. It is invoked immediately before EVERY wire
   * subscribe including the re-declare that follows a physical reconnect, so it
   * must not create transport or application state as a side effect - the same
   * contract `IStreamClient.subscribeWithParamsProvider` already imposes.
   */
  resumeOffer(): ResumeOffer;

  detach(reason: AdapterDetachReason): void;
}

/**
 * What happened to an outbound frame.
 *
 * Three outcomes rather than `void`, because the call site currently cannot
 * tell them apart and all three genuinely occur:
 *
 * - `"sent"` — it reached the transport.
 * - `"queued"` — the stream was not ready to send. Local artifact-body edits
 *   produced during a reconnect window are queued and replayed once a fresh
 *   snapshot confirms write permission; treating that as `"sent"` is how a
 *   reconnect silently discards user edits.
 * - `"dropped"` — deliberately not delivered and not retained. A frame handed
 *   to a stream session mid-reconnect is dropped on the floor by design (the
 *   streaming contracts are fire-and-forget and CRDT convergence absorbs the
 *   miss), and a viewer downgrade clears the queue fail-closed. Both are
 *   correct; both must be distinguishable from success.
 */
export type SendOutcome =
  | { readonly kind: "sent" }
  | { readonly kind: "queued"; readonly reason: string }
  | { readonly kind: "dropped"; readonly reason: string };

/**
 * The outbound half of a bidirectional lane — a doc update or awareness frame
 * going back to the authority, an on-demand range request, a coverage ack.
 *
 * Split from {@link LaneAdapter} rather than folded into it because read-only
 * lanes are the majority (the control lane has nothing to say) and a `send`
 * they must stub is a method someone will eventually call. An adapter that
 * writes implements both.
 */
export interface LaneRequester<TRequest> {
  send(request: TRequest): SendOutcome;
}

/**
 * The manifest-derived decision about which adapters serve this connection.
 *
 * Adapter selection is PER CONNECTION, not per session: a host that upgrades
 * under an open tab reconnects advertising the lanes, and the tab must move to
 * them. The runtime compares {@link fingerprint} across reconnects and treats a
 * change as replica replacement (`"manifest-changed"`) - epoch bump, fresh
 * snapshot through the new adapters, the same machinery as any other epoch
 * change. Every long-lived tab hits this exactly once.
 */
export interface AdapterSelection {
  readonly descriptors: readonly AdapterDescriptor[];
  /**
   * A stable digest of the negotiated capability set this selection was made
   * from. Compared for EQUALITY only - it is never parsed, ordered, or
   * inspected, so its format is the selector's business.
   */
  readonly fingerprint: string;
}

/**
 * Chooses adapters from whatever the transport negotiated.
 *
 * Generic over the manifest so the runtime does not depend on a protocol
 * registry shape that the lane contracts are still landing. Implementations
 * read `IStreamSession.getNegotiatedSchemaVersion()` (per-session, and the
 * correct source) or the client-wide negotiated-manifest registry.
 */
export interface AdapterSelector<TManifest> {
  select(manifest: TManifest): AdapterSelection;
}
