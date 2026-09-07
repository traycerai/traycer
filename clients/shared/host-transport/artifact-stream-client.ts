/**
 * Typed wrapper over the doc lane, `artifact.subscribe@1.0` - one artifact
 * body, bidirectionally synced, opened per open tile and closed with it.
 *
 * The only lane that carries binary payloads. Three server frames arrive with
 * bytes (`doc`, `docUpdate`, `awareness`) and two without (`docAck`,
 * `unavailable`); the contract declares which per frame, and a payload that
 * contradicts the declaration is dropped rather than reinterpreted.
 *
 * ## The attach is bound to ONE authority epoch, for life
 *
 * `authorityEpoch` is a required, non-null OPEN REQUEST field and it is
 * captured at construction rather than re-read per subscribe. That is the
 * contract, not an optimisation: an attach names the epic replica generation it
 * was made under, and an attach whose epoch the host is no longer serving is
 * refused with a terminal `unavailable / staleAuthorityEpoch`. Re-reading the
 * epoch on reconnect would silently convert that refusal into a successful
 * attach against a different replica - which is the history splice the epoch
 * exists to prevent. A new epoch means a NEW client, not a re-parameterised one.
 *
 * The seed offer IS re-read per subscribe, because it is the one thing whose
 * value changes with what this client has applied: a reattach that offers the
 * body it already holds is answered with a delta instead of the whole document.
 *
 * ## `seedOffer` is omitted, never sent as `undefined`
 *
 * The field is `.optional()` and never `.default()`, and absence is the wire
 * encoding of "no offer". Writing the key with an undefined value would
 * materialise a param the caller never wrote and split a subscription cache
 * between the params passed and the params parsed, for what is logically one
 * attach.
 */
import {
  artifactSubscribeServerFrameSchemaV10,
  type ArtifactSubscribeClientFrameV10,
  type ArtifactSubscribeSeedOffer,
  type ArtifactSubscribeServerFrameV10,
} from "@traycer/protocol/host/epic/artifact-subscribe";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { IStreamClient } from "./i-stream-client";

export const ARTIFACT_SUBSCRIBE_METHOD = "artifact.subscribe";

type ArtifactServerFrame<Kind extends ArtifactSubscribeServerFrameV10["kind"]> =
  Extract<ArtifactSubscribeServerFrameV10, { readonly kind: Kind }>;

export type ArtifactDocFrame = ArtifactServerFrame<"doc">;
export type ArtifactDocUpdateFrame = ArtifactServerFrame<"docUpdate">;
export type ArtifactDocAckFrame = ArtifactServerFrame<"docAck">;
export type ArtifactAwarenessFrame = ArtifactServerFrame<"awareness">;
export type ArtifactUnavailableFrame = ArtifactServerFrame<"unavailable">;

export interface ArtifactStreamCallbacks {
  /**
   * The body seed. `frame.seededFromOffer === true` means `bytes` is a DELTA
   * against the offer this client sent and MUST be merged into the very
   * replica that produced that offer; absence means a full, self-sufficient
   * seed. Both apply through the same CRDT merge, so the distinction forbids
   * the swap-in-a-fresh-doc path rather than selecting an apply function.
   */
  readonly onDoc: (frame: ArtifactDocFrame, bytes: Uint8Array) => void;
  readonly onDocUpdate: (
    frame: ArtifactDocUpdateFrame,
    bytes: Uint8Array,
  ) => void;
  /** Coverage for updates this client pushed. Carries no bytes. */
  readonly onDocAck: (frame: ArtifactDocAckFrame) => void;
  readonly onAwareness: (
    frame: ArtifactAwarenessFrame,
    bytes: Uint8Array,
  ) => void;
  readonly onUnavailable: (frame: ArtifactUnavailableFrame) => void;
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

export interface ArtifactStreamClientOptions {
  readonly wsStreamClient: IStreamClient<HostStreamRpcRegistry>;
  readonly epicId: string;
  readonly artifactId: string;
  /** The epic replica generation this attach is made under. Fixed for life. */
  readonly authorityEpoch: string;
  /**
   * The body state this client already holds, re-read immediately before every
   * wire subscribe including the re-declare after a reconnect. Pure and
   * synchronous by contract.
   */
  readonly seedOfferProvider: () => ArtifactSubscribeSeedOffer | null;
  readonly callbacks: ArtifactStreamCallbacks;
}

export class ArtifactStreamClient {
  private readonly session: IStreamSession;
  private readonly artifactId: string;
  private readonly callbacks: ArtifactStreamCallbacks;
  private closed = false;

  constructor(options: ArtifactStreamClientOptions) {
    this.artifactId = options.artifactId;
    this.callbacks = options.callbacks;
    this.session = options.wsStreamClient.subscribeWithParamsProvider(
      ARTIFACT_SUBSCRIBE_METHOD,
      () => {
        const seedOffer = options.seedOfferProvider();
        const base = {
          epicId: options.epicId,
          artifactId: options.artifactId,
          authorityEpoch: options.authorityEpoch,
        };
        return seedOffer === null ? base : { ...base, seedOffer };
      },
    );
    this.session.onServerFrame((envelope, binaryPayload) => {
      this.handleServerFrame(envelope, binaryPayload);
    });
    this.session.onStatusChange((status, reason) => {
      this.callbacks.onConnectionStatus(status, reason);
    });
  }

  /**
   * Pushes a local body edit. `docGuid` is the generation guard on the WRITE
   * path: a host that has reseeded this body drops an update naming the old
   * guid rather than merging it, so a stale replica cannot resurrect content a
   * reseed deliberately replaced.
   */
  applyUpdate(docGuid: string, updateBytes: Uint8Array): void {
    if (this.closed) return;
    const frame: ArtifactSubscribeClientFrameV10 = {
      kind: "applyUpdate",
      artifactId: this.artifactId,
      docGuid,
      hasBinaryPayload: true,
    };
    this.session.sendClientFrame(frame, updateBytes);
  }

  /** Presence for this body. Ephemeral: loss is correct, replay is wrong. */
  awareness(awarenessBytes: Uint8Array): void {
    if (this.closed) return;
    const frame: ArtifactSubscribeClientFrameV10 = {
      kind: "awareness",
      artifactId: this.artifactId,
      hasBinaryPayload: true,
    };
    this.session.sendClientFrame(frame, awarenessBytes);
  }

  /** Tears down the underlying session. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.session.close();
  }

  private handleServerFrame(
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ): void {
    if (this.closed) return;
    const parsed = artifactSubscribeServerFrameSchemaV10.safeParse(envelope);
    if (!parsed.success) return;
    const frame = parsed.data;
    // The address invariant the contract STATES but cannot enforce: every
    // non-`pong` frame names the artifact it belongs to, and it must be this
    // stream's. Bodies share one multiplexed connection with every other open
    // tile's lane, and the adapter above relabels each frame with its own
    // captured id rather than the wire's - so a misrouted `doc` would install
    // another artifact's bytes into this replica, and a stray `docAck` would
    // retire coverage this body never sent. Both are silent corruptions of a
    // document, which is why this is a drop and not a relabel: the schema
    // calls a mismatch a host bug, "not a routing instruction", so the one
    // thing the client must not do is honour it as an address.
    if (frame.kind !== "pong" && frame.artifactId !== this.artifactId) return;
    switch (frame.kind) {
      case "doc": {
        // A binary-declaring frame that arrived without its payload is a
        // crossed or truncated pair, not an empty document. Installing a
        // zero-byte "seed" over a live replica is unrecoverable, so the frame
        // is dropped and the host's next emission is what recovers it.
        if (binaryPayload === null) return;
        this.callbacks.onDoc(frame, binaryPayload);
        return;
      }
      case "docUpdate": {
        if (binaryPayload === null) return;
        this.callbacks.onDocUpdate(frame, binaryPayload);
        return;
      }
      case "awareness": {
        if (binaryPayload === null) return;
        this.callbacks.onAwareness(frame, binaryPayload);
        return;
      }
      case "docAck": {
        if (binaryPayload !== null) return;
        this.callbacks.onDocAck(frame);
        return;
      }
      case "unavailable": {
        if (binaryPayload !== null) return;
        this.callbacks.onUnavailable(frame);
        return;
      }
      case "pong":
        return;
    }
  }
}
