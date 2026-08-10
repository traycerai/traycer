import {
  resourcesSubscribeServerFrameSchema,
  type AppResourceSnapshotWire,
  type EpicResourceSnapshotWire,
  type HostTreeResourceSnapshotWire,
  type OtherResourceSnapshotWire,
  type OwnerResourceSnapshotWireV14,
  type ResourcesSubscribeOpenRequestV11,
  type ResourcesSubscribeServerFrame,
  type ResourcesSubscribeServerFrameV12,
  type ResourcesSubscribeServerFrameV13,
  type ResourcesSubscribeServerFrameV14,
  resourcesSubscribeServerFrameSchemaV12,
  resourcesSubscribeServerFrameSchemaV13,
  resourcesSubscribeServerFrameSchemaV14,
} from "@traycer/protocol/host/resources/subscribe";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { IStreamClient } from "./i-stream-client";

/**
 * The full per-epic resource projection carried by every `snapshot`/`update`
 * frame. The client replaces its view wholesale on each payload: an owner
 * absent from `owners` (or a `null` `epic`) is "not currently tracked", not
 * zero use.
 */
export interface ResourcesProjectionPayload {
  readonly epicId: string;
  readonly sampledAt: number;
  readonly app: AppResourceSnapshotWire | null;
  // Owners always carry `harnessId` and `managedCommand` downstream: a host on
  // `@1.3`/`@1.4` sends them; an older host has them backfilled to `null` in
  // `toPayload`. A host below `@1.4` never reports a managed-command owner at
  // all - it folds those trees into `other` - so the backfill loses nothing.
  readonly owners: readonly OwnerResourceSnapshotWireV14[];
  readonly epic: EpicResourceSnapshotWire | null;
  readonly epics: readonly EpicResourceSnapshotWire[];
  /** Absent when the connected host negotiated resources.subscribe <= 1.1. */
  readonly hostTree: HostTreeResourceSnapshotWire | null | undefined;
  /** Absent when the connected host negotiated resources.subscribe <= 1.1. */
  readonly other: OtherResourceSnapshotWire | null | undefined;
}

export type ResourcesStreamScope =
  | {
      readonly kind: "epic";
      readonly epicId: string;
    }
  | {
      readonly kind: "global";
    };

const GLOBAL_RESOURCES_EPIC_ID = "__global__";

function openRequestForScope(
  scope: ResourcesStreamScope,
): ResourcesSubscribeOpenRequestV11 {
  if (scope.kind === "epic") {
    return {
      epicId: scope.epicId,
      scope,
    };
  }
  return {
    epicId: GLOBAL_RESOURCES_EPIC_ID,
    scope,
  };
}

/**
 * Typed handlers for a `resources.subscribe@1.0` session.
 *
 * Frames flow server → client only (apart from the heartbeat handled by
 * `WsStreamClient`), so there is no upstream API on the wrapper. `onSnapshot`
 * fires once for the initial projection; `onUpdate` fires on each subsequent
 * materially-changed projection.
 */
export interface ResourcesStreamCallbacks {
  readonly onSnapshot: (payload: ResourcesProjectionPayload) => void;
  readonly onUpdate: (payload: ResourcesProjectionPayload) => void;
  /**
   * Connection-status changes. `reason` is non-null only on the
   * `closed` transition.
   */
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

export interface ResourcesStreamClientOptions {
  readonly wsStreamClient: IStreamClient<HostStreamRpcRegistry>;
  readonly scope: ResourcesStreamScope;
  readonly callbacks: ResourcesStreamCallbacks;
}

/**
 * Typed wrapper over `WsStreamClient` for `resources.subscribe@1.0`.
 *
 * Opens exactly one session on construction (bound to an epic or global scope),
 * binds the callback surface, and exposes `close`. Zod-parses each inbound
 * envelope and dispatches to the typed callback for its `kind`. There are no
 * upstream application frames; closing the session detaches the host-side
 * tracker listener via the connection-scoped teardown.
 */
export class ResourcesStreamClient {
  private readonly session: IStreamSession;
  private readonly callbacks: ResourcesStreamCallbacks;
  private closed: boolean;

  constructor(options: ResourcesStreamClientOptions) {
    this.callbacks = options.callbacks;
    this.closed = false;

    this.session = options.wsStreamClient.subscribe(
      "resources.subscribe",
      openRequestForScope(options.scope),
    );
    this.session.onServerFrame((envelope, binaryPayload) => {
      this.handleServerFrame(envelope, binaryPayload);
    });
    this.session.onStatusChange((status, reason) => {
      this.callbacks.onConnectionStatus(status, reason);
    });
  }

  /**
   * Tears down the underlying session. Idempotent.
   */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.session.close();
  }

  private handleServerFrame(
    envelope: StreamFrameEnvelope,
    _binaryPayload: Uint8Array | null,
  ): void {
    // Newest-first: `@1.4` (managed-command owners), `@1.3` (owners carry
    // harnessId), `@1.2` (hostTree + other), then the frozen `@1.0`/`@1.1`
    // base. Each schema strips unknown keys, so an older client parsing a newer
    // frame degrades cleanly.
    const parsed = parseNewestFirst(envelope);
    if (!parsed.success) {
      return;
    }
    const frame:
      | ResourcesSubscribeServerFrame
      | ResourcesSubscribeServerFrameV12
      | ResourcesSubscribeServerFrameV13
      | ResourcesSubscribeServerFrameV14 = parsed.data;
    switch (frame.kind) {
      case "snapshot": {
        this.callbacks.onSnapshot(toPayload(frame));
        return;
      }
      case "update": {
        this.callbacks.onUpdate(toPayload(frame));
        return;
      }
      case "pong": {
        // WsStreamClient handles pong internally for heartbeat bookkeeping.
        return;
      }
    }
  }
}

function parseNewestFirst(envelope: StreamFrameEnvelope) {
  const v14 = resourcesSubscribeServerFrameSchemaV14.safeParse(envelope);
  if (v14.success) return v14;
  const v13 = resourcesSubscribeServerFrameSchemaV13.safeParse(envelope);
  if (v13.success) return v13;
  const v12 = resourcesSubscribeServerFrameSchemaV12.safeParse(envelope);
  if (v12.success) return v12;
  return resourcesSubscribeServerFrameSchema.safeParse(envelope);
}

function toPayload(
  frame: Extract<
    | ResourcesSubscribeServerFrame
    | ResourcesSubscribeServerFrameV12
    | ResourcesSubscribeServerFrameV13
    | ResourcesSubscribeServerFrameV14,
    { kind: "snapshot" | "update" }
  >,
): ResourcesProjectionPayload {
  return {
    epicId: frame.epicId,
    sampledAt: frame.sampledAt,
    app: frame.app,
    // Backfill the later minors' owner fields for older frames so downstream
    // always reads a defined field: the provider is simply unknown on a host
    // below `@1.3`, and a host below `@1.4` reports no managed-command owners.
    owners: frame.owners.map((owner) => ({
      ...owner,
      harnessId: "harnessId" in owner ? owner.harnessId : null,
      managedCommand: "managedCommand" in owner ? owner.managedCommand : null,
    })),
    epic: frame.epic,
    epics: frame.epics ?? [],
    hostTree: "hostTree" in frame ? frame.hostTree : undefined,
    other: "other" in frame ? frame.other : undefined,
  };
}
