import {
  hostInventorySubscribeServerFrameSchemaV10,
  hostInventorySubscribeServerFrameSchemaV11,
  type HostInventorySubscribeServerFrameV10,
  type HostInventorySubscribeServerFrameV11,
} from "@traycer/protocol/host/host-inventory";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { IHostStreamClient } from "./host-stream-client";

/**
 * One inventory snapshot, as the serving host read it.
 *
 * The rows are the cloud's own registry rows, unprojected: the host has no
 * business deciding this client's plan gating, relay endpoint or clock skew,
 * so a consumer runs `hostListItemToDirectoryEntry` exactly as it would on a
 * body it fetched itself.
 */
export interface HostInventorySnapshot {
  readonly hosts: readonly HostListItem[];
  /** The serving host's clock at the read these rows came from. */
  readonly fetchedAtMs: number;
  /**
   * The serving host could not refresh these rows and is serving the last good
   * ones. NOT a reason to discard them - they are the freshest anyone has -
   * but it IS a reason for a consumer that has its own way to read the
   * registry to keep using it: the host reads with a device-bound credential
   * and a client reads with the user bearer, so a host whose credential needs
   * re-auth is stale in a way the client's own fetch is not.
   */
  readonly stale: boolean;
  /**
   * The rows are the account's WHOLE registry, sandbox rows included: the
   * stream negotiated @1.1. A @1.0 host (one that predates sandboxes) strips
   * every `kind: sandbox` row before it sends, so its snapshot is the personal
   * hosts alone; read as the whole fleet it would remove every sandbox each
   * time it arrives. A consumer that keeps a fleet takes a `false` snapshot
   * as a cue to re-read the registry itself, never as the fleet.
   */
  readonly includesSandboxRows: boolean;
}

export interface HostInventoryStreamCallbacks {
  onSnapshot(snapshot: HostInventorySnapshot): void;
  onConnectionStatus(
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ): void;
}

export interface HostInventoryStreamClientOptions {
  readonly wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>;
  readonly callbacks: HostInventoryStreamCallbacks;
}

/**
 * The newest `host.hostInventory.subscribe` minor this client has a parse arm
 * for.
 *
 * Exported for ONE purpose: a test pins it against
 * `hostStreamRpcRegistry["host.hostInventory.subscribe"][1].latestMinor`, so
 * registering a minor without adding an arm here fails loudly. The discipline
 * is `chat-records-stream-client.ts`'s, and it is here at minor 0 rather than
 * being added later on purpose - that file's own history is a minor being
 * negotiated and then parsed by the arm below it, silently dropping the very
 * fields the minor existed to carry, and the ladder is only safe if it starts
 * this way.
 */
export const HOST_INVENTORY_STREAM_PARSED_MINOR_CEILING = 1;

type ParsedFrame =
  | {
      readonly success: true;
      readonly data:
        | HostInventorySubscribeServerFrameV10
        | HostInventorySubscribeServerFrameV11;
    }
  | { readonly success: false };

function parseNegotiatedFrame(
  negotiated: SchemaVersion | null,
  envelope: StreamFrameEnvelope,
): ParsedFrame {
  // A minor with no arm of its own is DROPPED rather than parsed with the
  // newest arm this build has: these schemas are plain objects, so a newer
  // frame parsed with an older arm succeeds with the new minor's fields
  // stripped - the failure mode with no symptom. A drop has one, and the
  // consumer's fallback read covers it.
  if (
    negotiated !== null &&
    (negotiated.major !== 1 ||
      negotiated.minor > HOST_INVENTORY_STREAM_PARSED_MINOR_CEILING)
  ) {
    return { success: false };
  }
  // @1.1 rows may carry the sandbox fields and include `kind: sandbox` rows;
  // @1.0 (and the pre-handshake parse) is the frozen pre-sandbox row, which
  // REJECTS those fields rather than stripping them.
  if (negotiated !== null && negotiated.minor === 1) {
    return hostInventorySubscribeServerFrameSchemaV11.safeParse(envelope);
  }
  return hostInventorySubscribeServerFrameSchemaV10.safeParse(envelope);
}

/**
 * Subscribes to a host's inventory of the account's registry.
 *
 * Degrade contract: a host that does not advertise the method never opens a
 * session here, and every consumer keeps whatever read it already had. The
 * same is true of a session that drops - this client reports the status and
 * holds no retry policy of its own, because who re-opens (and how fast) is the
 * consumer's cadence question, not this wrapper's.
 */
export class HostInventoryStreamClient {
  private readonly session: IStreamSession;
  private readonly callbacks: HostInventoryStreamCallbacks;
  private closed = false;

  constructor(options: HostInventoryStreamClientOptions) {
    this.callbacks = options.callbacks;
    this.session = options.wsStreamClient.subscribe(
      "host.hostInventory.subscribe",
      {},
    );
    this.session.onServerFrame((envelope) => {
      this.handleServerFrame(envelope);
    });
    this.session.onStatusChange((status, reason) => {
      this.callbacks.onConnectionStatus(status, reason);
    });
  }

  /** Tears down the underlying session. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.session.close();
  }

  private handleServerFrame(envelope: StreamFrameEnvelope): void {
    // Read once: the minor that picked the parse arm is the minor that says
    // what the rows cover, even across a reconnect's renegotiation.
    const negotiated = this.session.getNegotiatedSchemaVersion();
    const parsed = parseNegotiatedFrame(negotiated, envelope);
    if (!parsed.success) return;
    const frame = parsed.data;
    if (frame.kind !== "snapshot") return;
    this.callbacks.onSnapshot({
      hosts: frame.hosts,
      fetchedAtMs: frame.fetchedAtMs,
      stale: frame.stale,
      // Only an arm that admits sandbox rows can carry all of them; @1.0 and
      // the pre-handshake parse cannot.
      includesSandboxRows: negotiated !== null && negotiated.minor >= 1,
    });
  }
}
