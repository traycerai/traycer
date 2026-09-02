import {
  resourcesSubscribeServerFrameSchema,
  type AppResourceSnapshotWire,
  type AppResourceSnapshotWireV15,
  type EpicResourceSnapshotWire,
  type EpicResourceSnapshotWireV15,
  type HostTreeResourceSnapshotWire,
  type HostTreeResourceSnapshotWireV15,
  type OtherResourceSnapshotWire,
  type OtherResourceSnapshotWireV15,
  type OwnerResourceSnapshotWireV15,
  type ResourceProcessSnapshotWire,
  type ResourceProcessSnapshotWireV15,
  type RestrictedResourceSnapshotWireV15,
  type ResourcesSubscribeOpenRequestV11,
  type ResourcesSubscribeDemand,
  type ResourcesSubscribeServerFrame,
  type ResourcesSubscribeServerFrameV12,
  type ResourcesSubscribeServerFrameV13,
  type ResourcesSubscribeServerFrameV14,
  type ResourcesSubscribeServerFrameV15,
  resourcesSubscribeServerFrameSchemaV12,
  resourcesSubscribeServerFrameSchemaV13,
  resourcesSubscribeServerFrameSchemaV14,
  resourcesSubscribeServerFrameSchemaV15,
} from "@traycer/protocol/host/resources/subscribe";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  isMethodIncompatibleClose,
  type IStreamSession,
  type StreamCloseReason,
  type StreamConnectionStatus,
  type StreamFrameEnvelope,
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
  readonly app: AppResourceSnapshotWireV15 | null;
  // Owners always carry `harnessId` and `managedCommand` downstream: a host on
  // `@1.3`/`@1.4` sends them; an older host has them backfilled to `null` in
  // `toPayload`. A host below `@1.4` never reports a managed-command owner at
  // all - it folds those trees into `other` - so the backfill loses nothing.
  readonly owners: readonly OwnerResourceSnapshotWireV15[];
  readonly epic: EpicResourceSnapshotWireV15 | null;
  readonly epics: readonly EpicResourceSnapshotWireV15[];
  /** Absent when the connected host negotiated resources.subscribe <= 1.1. */
  readonly hostTree: HostTreeResourceSnapshotWireV15 | null | undefined;
  /** Absent when the connected host negotiated resources.subscribe <= 1.1. */
  readonly other: OtherResourceSnapshotWireV15 | null | undefined;
  /** Aggregate-only usage hidden by authorization/scope; @1.5+ only. */
  readonly restricted: RestrictedResourceSnapshotWireV15 | null | undefined;
}

export type ResourcesStreamScope =
  | {
      readonly kind: "epic";
      readonly epicId: string;
    }
  | {
      readonly kind: "global";
    };

/**
 * Whether a NEGOTIATED `resources.subscribe` version can serve a global-scope
 * subscribe. The global scope arrived in `@1.1`; `@1.0` predates the `scope`
 * field entirely.
 *
 * Exported because two places have to agree on the threshold and must not
 * drift: this client, which reads the version its own session negotiated, and
 * the renderer's pre-check, which reads the client-wide one before any session
 * exists. Takes a non-null version on purpose - "not negotiated yet" is not a
 * verdict, and each caller has its own reason for that state.
 */
export function supportsGlobalResourcesScope(version: SchemaVersion): boolean {
  return version.major === 1 && version.minor >= 1;
}

/**
 * Whether the host on the other end of THIS session can serve the scope it was
 * opened for. `"unknown"` until a negotiation settles, and again from the
 * moment one is dropped by a reconnect - a reconnect may reach a new host
 * incarnation, so capability has to be re-probed rather than remembered (the
 * same discipline `WsStreamClient.resetMethodSupport` follows).
 */
export type ResourcesScopeSupport = "unknown" | "supported" | "unsupported";

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
 * Projection frames flow server → client. `@1.5+` also accepts the small
 * visibility-demand hint exposed by `setDemand`; heartbeat remains transport
 * owned. `onSnapshot` fires once for the initial projection and `onUpdate`
 * fires on each subsequent materially-changed projection.
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
  /**
   * Fires when the verdict on this session's scope changes - see
   * {@link ResourcesScopeSupport}. Never fires with the value the consumer
   * already holds, so it is safe to drive a store write directly.
   */
  readonly onScopeSupport: (support: ResourcesScopeSupport) => void;
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
  private readonly scope: ResourcesStreamScope;
  private readonly callbacks: ResourcesStreamCallbacks;
  private closed: boolean;
  private scopeSupport: ResourcesScopeSupport = "unknown";
  private demand: ResourcesSubscribeDemand = "background";
  // Seeded (and re-seeded on every drop) with the cadence the host starts a
  // subscription at, so a background holder never spends a frame restating it.
  private sentDemand: ResourcesSubscribeDemand = "background";

  constructor(options: ResourcesStreamClientOptions) {
    this.callbacks = options.callbacks;
    this.scope = options.scope;
    this.closed = false;

    this.session = options.wsStreamClient.subscribe(
      "resources.subscribe",
      openRequestForScope(options.scope),
    );
    this.session.onServerFrame((envelope, binaryPayload) => {
      this.handleServerFrame(envelope, binaryPayload);
    });
    this.session.onStatusChange((status, reason) => {
      if (status !== "open") this.sentDemand = "background";
      // Before the status itself, so a consumer reacting to the `closed`
      // transition already sees why rather than reading last round's verdict.
      this.updateScopeSupport(status, reason);
      if (status === "open") this.publishDemandIfSupported();
      this.callbacks.onConnectionStatus(status, reason);
    });
  }

  /**
   * Sets the desired host sampling tier. The choice survives reconnects and is
   * sent only to `@1.5+`; older hosts retain their historical server-defined
   * fast cadence.
   */
  setDemand(demand: ResourcesSubscribeDemand): void {
    if (this.closed || this.demand === demand) return;
    this.demand = demand;
    this.publishDemandIfSupported();
  }

  private publishDemandIfSupported(): void {
    if (this.closed || this.sentDemand === this.demand) return;
    const version = this.session.getNegotiatedSchemaVersion();
    if (version === null || version.major !== 1 || version.minor < 5) return;
    this.session.sendClientFrame(
      {
        kind: "setDemand",
        demand: this.demand,
        hasBinaryPayload: false,
      },
      null,
    );
    this.sentDemand = this.demand;
  }

  /**
   * Publishes the scope verdict when - and only when - this transition carried
   * evidence that changes it.
   *
   * This exists because the pre-check it backs up cannot answer on a remote
   * host: `RemoteStreamClient` reports `"unknown"` support and a `null`
   * client-wide schema version for every method by design. What a remote
   * session DOES produce is this session's own negotiated version and, for a
   * method the host never advertises, a terminal incompatible close - and both
   * are equally available on the local transport, so one rule covers both.
   *
   * Not folded into the version test: an `@1.0` host does NOT fail a global
   * subscribe. The `@1.1` request keeps `epicId` on the wire precisely so the
   * probe downgrades cleanly, so an old host accepts it, reads only `epicId`,
   * and answers with one empty projection for an epic named `__global__` that
   * does not exist. It looks exactly like a healthy stream on a quiet machine,
   * which is why the negotiated VERSION - not the close - is what catches it.
   */
  private updateScopeSupport(
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ): void {
    const next = this.deriveScopeSupport(status, reason);
    if (next === null || next === this.scopeSupport) {
      return;
    }
    this.scopeSupport = next;
    this.callbacks.onScopeSupport(next);
  }

  /** `null` = this transition carried no evidence; hold the current verdict. */
  private deriveScopeSupport(
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ): ResourcesScopeSupport | null {
    if (status === "closed") {
      // Every other close - caller teardown, an auth rejection, a plan gate -
      // is about this attempt, not about what the host can serve. Holding the
      // previous verdict is what keeps a terminal incompatible close STANDING:
      // it is disposed, so nothing follows it that could clear the notice.
      //
      // This verdict cannot expire on its own, and that asymmetry is the point.
      // A version verdict SELF-HEALS: that stream stays open, so a drop takes
      // its negotiated version with it (see below), the verdict falls back to
      // "unknown", and the resume re-negotiates - an upgraded host clears
      // itself. A terminal close has no such path: an incompatible METHOD fails
      // only the stream (`RemoteSession.openSubscription` calls `goFatal` and
      // deletes the subscription) while the shared session stays healthy, so
      // the transport identity never changes and nothing here re-probes.
      //
      // Clearing it is therefore an OWNER's job, not this rule's: the verdict
      // is what this session observed, and this session will observe nothing
      // further. `GlobalResourcesStreamMount` re-probes by rebuilding the
      // stream when the transport reports the endpoint recovered - the only
      // evidence that the host on the other end may not be the one we judged.
      return isMethodIncompatibleClose(reason) ? "unsupported" : null;
    }
    // Otherwise the verdict is worth exactly what this session's negotiated
    // version is worth - and `connecting` / `reconnecting` have none, BY
    // CONTRACT: `getNegotiatedSchemaVersion` is null before a handshake settles
    // and null again the moment a drop takes it. That is what re-probes a
    // reconnect instead of carrying a verdict across it, which matters because
    // a reconnect may reach a NEW host incarnation - an upgrade is exactly how
    // a host stops being too old. One rule rather than a separate reset, so
    // there is no second place for the two to disagree.
    const negotiated = this.session.getNegotiatedSchemaVersion();
    if (negotiated === null) {
      return "unknown";
    }
    if (this.scope.kind === "epic") {
      // Every version of this method serves an epic scope; opening at all is
      // the proof.
      return "supported";
    }
    return supportsGlobalResourcesScope(negotiated)
      ? "supported"
      : "unsupported";
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
    // Parse at the version this session NEGOTIATED, not at whichever shape
    // happens to accept the bytes. Trialling newest-first lets one bad field
    // silently demote a `@1.5` frame to `@1.4` - which strips the memory
    // detail the frame exists to carry, and, once `rssBytes` is null, fails
    // every older shape too and drops the projection with no signal at all.
    // The ladder survives only for a frame that arrives before a handshake
    // settles, where there is no negotiated version to parse at.
    const version = this.session.getNegotiatedSchemaVersion();
    const negotiated = version !== null && version.major === 1 ? version : null;
    const parsed =
      negotiated === null
        ? parseNewestFirst(envelope)
        : parseAtMinor(envelope, negotiated.minor);
    if (!parsed.success) {
      if (negotiated !== null) {
        // Bounded and constant: the offending body is remote input and never
        // rendered into a log line.
        console.error(
          `[stream] resources.subscribe frame failed its negotiated schema @1.${negotiated.minor}; dropping frame`,
        );
      }
      return;
    }
    const frame:
      | ResourcesSubscribeServerFrame
      | ResourcesSubscribeServerFrameV12
      | ResourcesSubscribeServerFrameV13
      | ResourcesSubscribeServerFrameV14
      | ResourcesSubscribeServerFrameV15 = parsed.data;
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

/** The one schema the negotiated minor promises; `@1.5+` reads as `@1.5`. */
function parseAtMinor(envelope: StreamFrameEnvelope, minor: number) {
  if (minor >= 5) {
    return resourcesSubscribeServerFrameSchemaV15.safeParse(envelope);
  }
  if (minor === 4) {
    return resourcesSubscribeServerFrameSchemaV14.safeParse(envelope);
  }
  if (minor === 3) {
    return resourcesSubscribeServerFrameSchemaV13.safeParse(envelope);
  }
  if (minor === 2) {
    return resourcesSubscribeServerFrameSchemaV12.safeParse(envelope);
  }
  return resourcesSubscribeServerFrameSchema.safeParse(envelope);
}

/** Only for a frame that beats its own handshake - see `handleServerFrame`. */
function parseNewestFirst(envelope: StreamFrameEnvelope) {
  const v15 = resourcesSubscribeServerFrameSchemaV15.safeParse(envelope);
  if (v15.success) return v15;
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
    | ResourcesSubscribeServerFrameV14
    | ResourcesSubscribeServerFrameV15,
    { kind: "snapshot" | "update" }
  >,
): ResourcesProjectionPayload {
  return {
    epicId: frame.epicId,
    sampledAt: frame.sampledAt,
    app: frame.app === null ? null : normalizeApp(frame.app),
    // Backfill the later minors' owner fields for older frames so downstream
    // always reads a defined field: the provider is simply unknown on a host
    // below `@1.3`, and a host below `@1.4` reports no managed-command owners.
    owners: frame.owners.map((owner) => ({
      ...owner,
      ...memoryDetailsOrNull(owner),
      harnessId: "harnessId" in owner ? owner.harnessId : null,
      managedCommand: "managedCommand" in owner ? owner.managedCommand : null,
      processes: owner.processes.map(normalizeProcess),
    })),
    epic: frame.epic === null ? null : normalizeEpic(frame.epic),
    epics: (frame.epics ?? []).map(normalizeEpic),
    hostTree:
      "hostTree" in frame
        ? frame.hostTree === null
          ? null
          : normalizeHostTree(frame.hostTree)
        : undefined,
    other:
      "other" in frame
        ? frame.other === null
          ? null
          : normalizeOther(frame.other)
        : undefined,
    restricted: "restricted" in frame ? frame.restricted : undefined,
  };
}

function normalizeProcess(
  process: ResourceProcessSnapshotWire | ResourceProcessSnapshotWireV15,
): ResourceProcessSnapshotWireV15 {
  return {
    ...process,
    ...memoryDetailsOrNull(process),
    descriptor: "descriptor" in process ? process.descriptor : null,
  };
}

/**
 * `cpuPercent` is named only so this is a reading rather than an all-optional
 * weak type: every wire reading carries it, and a frozen-minor one - which has
 * neither memory field - has nothing else in common to satisfy the check.
 */
function memoryDetailsOrNull(value: {
  readonly cpuPercent: number;
  readonly pssBytes?: number | null;
  readonly privateBytes?: number | null;
}): { readonly pssBytes: number | null; readonly privateBytes: number | null } {
  return {
    pssBytes: value.pssBytes ?? null,
    privateBytes: value.privateBytes ?? null,
  };
}

function normalizeApp(
  app: AppResourceSnapshotWire | AppResourceSnapshotWireV15,
): AppResourceSnapshotWireV15 {
  return {
    ...app,
    ...memoryDetailsOrNull(app),
    process: app.process === null ? null : normalizeProcess(app.process),
  };
}

function normalizeEpic(
  epic: EpicResourceSnapshotWire | EpicResourceSnapshotWireV15,
): EpicResourceSnapshotWireV15 {
  return { ...epic, ...memoryDetailsOrNull(epic) };
}

function normalizeHostTree(
  hostTree: HostTreeResourceSnapshotWire | HostTreeResourceSnapshotWireV15,
): HostTreeResourceSnapshotWireV15 {
  return { ...hostTree, ...memoryDetailsOrNull(hostTree) };
}

function normalizeOther(
  other: OtherResourceSnapshotWire | OtherResourceSnapshotWireV15,
): OtherResourceSnapshotWireV15 {
  return {
    ...other,
    ...memoryDetailsOrNull(other),
    processes: other.processes.map(normalizeProcess),
  };
}
