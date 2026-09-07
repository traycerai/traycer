/**
 * An adapter decodes one wire lane into replica events and owns that lane's stream lifecycle, generation guard, and resume cursor.
 * Adapters are the only components in the runtime that know a wire exists.
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
 * Consumers that need to degrade gracefully read this rather than sniffing behaviour.
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

export interface AdapterStatus {
  readonly connection: StreamConnectionStatus;
  /** Non-null only on a `"closed"` transition. */
  readonly closeReason: StreamCloseReason | null;
}

export interface AdapterHost<TEvent> {
  readonly environment: RuntimeEnvironment;

  /** Deliver one decoded event. */
  emit(event: TEvent): void;

  /** Report an observed resume outcome. */
  reportResume(outcome: ResumeOutcome): void;

  reportStatus(status: AdapterStatus): void;

  /** Ask the runtime to rebuild the replica this adapter feeds. */
  /** The runtime widens this to `{ origin: "authority", reason }` when it drives the reset. */
  /**
   * `transition` names which occurrence this is, so the runtime can collapse the same one reported by two lanes without having to clear a guard between genuine ones.
   * Build it with the `*Transition` helpers in `replica.ts`; see {@link ReplicaTransitionToken} for why the reason cannot do this job.
   */
  requestReplacement(
    reason: ReplicaReplacementReason,
    transition: ReplicaTransitionToken,
  ): void;
}

/**
 * Why an adapter is being detached.
 * `detachTransport()` already exists in the open-epic store - keep the replica, drop the socket - and it is one of the two artifacts proving the runtime/adapter distinction was latent in the code before anyone named it.
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

  /** Begin decoding into `host`. */
  attach(host: AdapterHost<TEvent>): void;

  /** The cursor this adapter would offer on its next (re)subscribe. */
  resumeOffer(): ResumeOffer;

  detach(reason: AdapterDetachReason): void;
}

/**
 * What happened to an outbound frame.
 * Three outcomes rather than `void`, because the call site currently cannot tell them apart and all three genuinely occur: - `"sent"` - it reached the transport.
 */
export type SendOutcome =
  | { readonly kind: "sent" }
  | { readonly kind: "queued"; readonly reason: string }
  | { readonly kind: "dropped"; readonly reason: string };

  /**
   * The outbound half of a bidirectional lane - a doc update or awareness frame going back to the authority, an on-demand range request, a coverage ack.
   * Split from {@link LaneAdapter} rather than folded into it because read-only lanes are the majority (the control lane has nothing to say) and a `send` they must stub is a method someone will eventually call.
   */
export interface LaneRequester<TRequest> {
  send(request: TRequest): SendOutcome;
}

/**
 * The manifest-derived decision about which adapters serve this connection.
 * Adapter selection is per connection, not per session: a host that upgrades under an open tab reconnects advertising the lanes, and the tab must move to them.
 */
export interface AdapterSelection {
  readonly descriptors: readonly AdapterDescriptor[];
  /**
   * A stable digest of the negotiated capability set this selection was made from.
   * Compared for equality only - it is never parsed, ordered, or inspected, so its format is the selector's business.
   */
  readonly fingerprint: string;
}

export interface AdapterSelector<TManifest> {
  select(manifest: TManifest): AdapterSelection;
}
