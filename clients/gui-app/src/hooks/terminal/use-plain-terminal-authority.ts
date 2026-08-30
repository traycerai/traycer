import { useEffect, useMemo, useRef, useState } from "react";
import {
  useQueryClient,
  type QueryClient,
  type QueryKey,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import { isMethodIncompatibleClose } from "@traycer-clients/shared/host-transport/i-stream-session";
import { PlainTerminalListStreamClient } from "@traycer-clients/shared/host-transport/plain-terminal-list-stream-client";
import type {
  HostRpcRegistry,
  HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import type {
  PlainTerminalListState,
  PlainTerminalProjection,
  PlainTerminalScope,
} from "@traycer/protocol/host/terminal/plain-schemas";
import { PLAIN_TERMINAL_LOCAL_FAMILY_VERSION } from "@traycer/protocol/host/terminal/plain-contracts";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useHostCapabilityProbe } from "@/hooks/host/use-host-capability-probe";
import { useHostClientFor } from "@/hooks/host/use-host-client-for";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostQueryWithResponseMap } from "@/hooks/host/use-host-query";
import {
  useHostStreamClientBindingFor,
  type HostStreamClientBinding,
} from "@/hooks/host/use-host-stream-client-for";
import {
  useHostMethodSchemaVersion,
  useHostMethodSupport,
} from "@/hooks/host/use-host-supports-method";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import {
  useStreamMethodSchemaVersionFor,
  useStreamMethodSupportFor,
} from "@/lib/host/stream-runtime-context";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import {
  PLAIN_TERMINAL_STREAM_METHOD,
  capturePlainTerminalProjectionBarrier,
  markPlainTerminalStreamIncompatible,
  plainTerminalAuthorityCanMutate,
  plainTerminalCollectionIdentityKey,
  plainTerminalCollectionValues,
  plainTerminalHostScopeIdentityKey,
  replacePlainTerminalState,
  resolvePlainTerminalCapability,
  seedPlainTerminalList,
  settlePlainTerminalSnapshot,
  setPlainTerminalStreamStatus,
  type PlainTerminalCapability,
  type PlainTerminalCollection,
  type PlainTerminalProjectionBarrier,
  type PlainTerminalRpcMethod,
} from "@/lib/terminals/plain-terminal-authority";
import {
  acknowledgedPlainTerminalPresentationIdsForScope,
  commitPlainTerminalSnapshotOmission,
  reconcileRetainedPlainTerminalTombstones,
} from "@/lib/terminals/plain-terminal-presentation-invalidation";
import {
  useEpicCanvasStore,
  type EpicCanvasStore,
} from "@/stores/epics/canvas/store";
import {
  isUnsupportedEpicTerminalRef,
  type EpicCanvasTileRef,
} from "@/stores/epics/canvas/types";
import {
  useLandingTerminalStore,
  type LandingTerminalTabRef,
} from "@/stores/home/landing-terminal-store";

interface ActivePlainTerminalStream {
  readonly hostId: string;
  readonly scopeKey: string;
  readonly streamClient: IHostStreamClient<HostStreamRpcRegistry>;
  readonly transportKey: string | null;
  readonly capabilityIncarnation: string;
  readonly release: () => void;
}

interface SharedPlainTerminalStreamOwner {
  /** Consumer identity -> latest acquisition lease for stale-release safety. */
  readonly consumers: Map<symbol, symbol>;
  readonly streamClient: IHostStreamClient<HostStreamRpcRegistry>;
  readonly transportKey: string | null;
  readonly capabilityIncarnation: string;
  readonly stream: PlainTerminalListStreamClient;
  readonly unpin: (() => void) | null;
}

const sharedStreamOwners = new WeakMap<
  QueryClient,
  Map<string, SharedPlainTerminalStreamOwner>
>();

function sharedStreamOwnerKey(
  hostId: string,
  scope: PlainTerminalScope,
): string {
  return plainTerminalHostScopeIdentityKey(hostId, scope);
}

function pushHostEpicPresentationId(args: {
  readonly ids: string[];
  readonly prefix: string;
  readonly tabId: string;
  readonly instanceId: string;
  readonly ref: EpicCanvasTileRef | null | undefined;
  readonly tombstonedIdentities: ReadonlySet<string>;
}): void {
  if (
    args.ref?.type === "terminal" &&
    !isUnsupportedEpicTerminalRef(args.ref) &&
    args.tombstonedIdentities.has(
      plainTerminalCollectionIdentityKey(args.ref.hostId, args.ref.id),
    )
  ) {
    args.ids.push(
      `${args.prefix}:${args.tabId}:${args.instanceId}:${plainTerminalCollectionIdentityKey(args.ref.hostId, args.ref.id)}`,
    );
  }
}

/**
 * Change token for the retained-tombstone sweep, not a general presentation
 * signature. The sweep can only ever act on a tombstoned id, so the token
 * ignores every other ref - and short-circuits entirely while no tombstone is
 * retained, which is the steady state. That keeps this out of the hot path:
 * a Zustand selector runs on every store commit, including the pane-focus,
 * layout and tile-state commits that have nothing to do with terminals, and
 * every mounted authority in the cohort pays for it.
 */
function epicTombstonePresentationTokenForHost(
  tombstonedIdentities: ReadonlySet<string>,
  state: Pick<EpicCanvasStore, "canvasByTabId" | "closedTilePayloadsByTabId">,
): string {
  if (tombstonedIdentities.size === 0) return "";
  const ids: string[] = [];
  for (const [tabId, canvas] of Object.entries(state.canvasByTabId)) {
    for (const [instanceId, ref] of Object.entries(
      canvas?.tilesByInstanceId ?? {},
    )) {
      pushHostEpicPresentationId({
        ids,
        prefix: "live",
        tabId,
        instanceId,
        ref,
        tombstonedIdentities,
      });
    }
  }
  for (const [tabId, forTab] of Object.entries(
    state.closedTilePayloadsByTabId,
  )) {
    for (const [instanceId, payload] of Object.entries(forTab ?? {})) {
      pushHostEpicPresentationId({
        ids,
        prefix: "closed",
        tabId,
        instanceId,
        ref: payload?.node,
        tombstonedIdentities,
      });
    }
  }
  return ids.sort().join("|");
}

function landingTombstonePresentationTokenForHost(
  tombstonedIdentities: ReadonlySet<string>,
  tabs: readonly LandingTerminalTabRef[],
): string {
  if (tombstonedIdentities.size === 0) return "";
  return tabs
    .filter((tab) =>
      tombstonedIdentities.has(
        plainTerminalCollectionIdentityKey(tab.hostId, tab.sessionId),
      ),
    )
    .map((tab) => `${tab.instanceId}:${tab.hostId}:${tab.sessionId}`)
    .sort()
    .join("|");
}

/**
 * Scope-level retained-tombstone ingress. Observes live and closed
 * presentation independently of mutation readiness so a reconnecting client
 * still sweeps a late closed-only epic payload.
 */
function useRetainedPlainTerminalTombstoneReconciliation(args: {
  readonly hostId: string;
  readonly queryKey: QueryKey;
  readonly deletedRevisionByIdentity:
    | Readonly<Partial<Record<string, number>>>
    | undefined;
}): void {
  const queryClient = useQueryClient();
  const deletedRevisionByIdentity = args.deletedRevisionByIdentity;
  const tombstonedIdentities = useMemo(
    () => new Set(Object.keys(deletedRevisionByIdentity ?? {})),
    [deletedRevisionByIdentity],
  );
  const epicToken = useEpicCanvasStore((state) =>
    epicTombstonePresentationTokenForHost(tombstonedIdentities, state),
  );
  const landingToken = useLandingTerminalStore((state) =>
    landingTombstonePresentationTokenForHost(tombstonedIdentities, state.tabs),
  );
  useEffect(() => {
    reconcileRetainedPlainTerminalTombstones({
      queryClient,
      queryKey: args.queryKey,
      hostId: args.hostId,
    });
  }, [
    queryClient,
    args.queryKey,
    args.hostId,
    args.deletedRevisionByIdentity,
    epicToken,
    landingToken,
  ]);
}

function sharedOwnerNeedsReplacement(
  owner: SharedPlainTerminalStreamOwner,
  transportKey: string | null,
  capabilityIncarnation: string,
): boolean {
  return (
    owner.transportKey !== transportKey ||
    owner.capabilityIncarnation !== capabilityIncarnation ||
    owner.streamClient.isClosed()
  );
}

function acquireSharedPlainTerminalStream(args: {
  readonly queryClient: QueryClient;
  readonly ownerKey: string;
  readonly consumer: symbol;
  readonly streamClient: IHostStreamClient<HostStreamRpcRegistry>;
  readonly streamBinding: HostStreamClientBinding | null;
  readonly capabilityIncarnation: string;
  readonly open: () => PlainTerminalListStreamClient;
}): () => void {
  let owners = sharedStreamOwners.get(args.queryClient);
  if (owners === undefined) {
    owners = new Map();
    sharedStreamOwners.set(args.queryClient, owners);
  }
  let owner = owners.get(args.ownerKey);
  const transportKey = args.streamBinding?.transportKey ?? null;
  const replaceOwner =
    owner !== undefined &&
    sharedOwnerNeedsReplacement(
      owner,
      transportKey,
      args.capabilityIncarnation,
    );
  const existingConsumers = owner?.consumers ?? new Map<symbol, symbol>();
  if (replaceOwner && owner !== undefined) {
    // Mounted sibling leases transfer to the replacement owner. Their older
    // release closures can retire only the exact lease they acquired.
    owner.stream.close();
    owner.unpin?.();
    owners.delete(args.ownerKey);
    owner = undefined;
  }
  if (owner === undefined) {
    args.streamBinding?.pin();
    let stream: PlainTerminalListStreamClient;
    try {
      stream = args.open();
    } catch (error) {
      args.streamBinding?.unpin();
      throw error;
    }
    owner = {
      consumers: existingConsumers,
      streamClient: args.streamClient,
      transportKey,
      capabilityIncarnation: args.capabilityIncarnation,
      stream,
      unpin: args.streamBinding?.unpin ?? null,
    };
    owners.set(args.ownerKey, owner);
  }
  const lease = Symbol("plain-terminal-authority-lease");
  owner.consumers.set(args.consumer, lease);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = owners.get(args.ownerKey);
    if (current === undefined) return;
    if (current.consumers.get(args.consumer) !== lease) return;
    current.consumers.delete(args.consumer);
    if (current.consumers.size > 0) return;
    current.stream.close();
    current.unpin?.();
    owners.delete(args.ownerKey);
    if (owners.size === 0) sharedStreamOwners.delete(args.queryClient);
  };
}

export interface PlainTerminalAuthorityResult {
  readonly hostId: string;
  readonly scope: PlainTerminalScope;
  readonly capability: PlainTerminalCapability;
  readonly collection: PlainTerminalCollection | undefined;
  readonly terminals: readonly PlainTerminalProjection[];
  readonly coverage: PlainTerminalCollection["coverage"];
  readonly servingHostId: string | null;
  readonly canMutate: boolean;
  readonly query: UseQueryResult<PlainTerminalCollection, HostRpcError>;
}

function plainTerminalStreamVersionCompatible(
  version: SchemaVersion | null,
  capability: PlainTerminalCapability,
): boolean {
  if (version === null) return true;
  return (
    capability.status === "capable" &&
    version.major === capability.schemaVersion.major &&
    version.minor === capability.schemaVersion.minor
  );
}

export function usePlainTerminalAuthority(args: {
  readonly hostId: string;
  readonly scope: PlainTerminalScope;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly streamClient: IHostStreamClient<HostStreamRpcRegistry> | null;
  /** Pins a transient transport while the shared owner still has consumers. */
  readonly streamBinding?: HostStreamClientBinding | null;
  /** Stable evidence for a genuine host/capability generation. */
  readonly capabilityIncarnation: string;
}): PlainTerminalAuthorityResult {
  const queryClient = useQueryClient();
  const activeStreamRef = useRef<ActivePlainTerminalStream | null>(null);
  const [streamConsumer] = useState(() => Symbol("plain-terminal-authority"));
  const transportKey = args.streamBinding?.transportKey ?? null;
  const epicId = args.scope.kind === "epic" ? args.scope.epicId : null;
  const stableScope = useMemo<PlainTerminalScope>(
    () =>
      epicId === null ? { kind: "independent" } : { kind: "epic", epicId },
    [epicId],
  );
  const listSupport = useHostMethodSupport(args.hostId, "terminal.plain.list");
  const createVersion = useHostMethodSchemaVersion(
    args.hostId,
    "terminal.plain.create",
  );
  const listVersion = useHostMethodSchemaVersion(
    args.hostId,
    "terminal.plain.list",
  );
  const renameVersion = useHostMethodSchemaVersion(
    args.hostId,
    "terminal.plain.rename",
  );
  const ensureVersion = useHostMethodSchemaVersion(
    args.hostId,
    "terminal.plain.ensureRunning",
  );
  const closeVersion = useHostMethodSchemaVersion(
    args.hostId,
    "terminal.plain.close",
  );
  const importVersion = useHostMethodSchemaVersion(
    args.hostId,
    "terminal.plain.importLegacy",
  );
  // Keyed by method-name literal so a reorder or extension of
  // `PLAIN_TERMINAL_RPC_METHODS` cannot silently bind a version to the wrong
  // method. `PlainTerminalRpcMethod` keeps the map exhaustive at compile time.
  const versions: Readonly<
    Record<PlainTerminalRpcMethod, SchemaVersion | null>
  > = {
    "terminal.plain.create": createVersion,
    "terminal.plain.list": listVersion,
    "terminal.plain.rename": renameVersion,
    "terminal.plain.ensureRunning": ensureVersion,
    "terminal.plain.close": closeVersion,
    "terminal.plain.importLegacy": importVersion,
  };
  const unaryCapability = resolvePlainTerminalCapability({
    manifestKnown: listSupport !== null,
    versionFor: (method) => versions[method],
  });

  useHostCapabilityProbe({
    client: args.client,
    stale: unaryCapability.status !== "capable",
    incarnation: [args.capabilityIncarnation],
  });

  const streamSupport = useStreamMethodSupportFor(
    args.streamClient,
    PLAIN_TERMINAL_STREAM_METHOD,
  );
  const streamVersion = useStreamMethodSchemaVersionFor(
    args.streamClient,
    PLAIN_TERMINAL_STREAM_METHOD,
  );
  const streamVersionCompatible = plainTerminalStreamVersionCompatible(
    streamVersion,
    unaryCapability,
  );
  const queryKey = useMemo(
    () => hostQueryKeys.plainTerminals(args.hostId, stableScope),
    [args.hostId, stableScope],
  );
  const scopeKey = plainTerminalHostScopeIdentityKey(args.hostId, stableScope);

  const query = useHostQueryWithResponseMap<
    HostRpcRegistry,
    "terminal.plain.list",
    PlainTerminalCollection,
    PlainTerminalProjectionBarrier
  >({
    client: args.client,
    method: "terminal.plain.list",
    params: { scope: stableScope },
    cacheKeyIdentity: [],
    options: {
      enabled:
        unaryCapability.status === "capable" &&
        streamSupport !== "unsupported" &&
        streamVersionCompatible,
    },
    captureRequestContext: () =>
      capturePlainTerminalProjectionBarrier(
        queryClient.getQueryData<PlainTerminalCollection>(queryKey),
      ),
    mapResponse: ({
      response,
      queryClient: cache,
      queryKey: mappedKey,
      requestContext,
    }) => {
      let normalizedResponse = response;
      if (
        unaryCapability.status === "capable" &&
        unaryCapability.schemaVersion.major ===
          PLAIN_TERMINAL_LOCAL_FAMILY_VERSION.major
      ) {
        normalizedResponse =
          stableScope.kind === "independent"
            ? {
                ...response,
                coverage: "complete-local",
                scope: stableScope,
              }
            : {
                ...response,
                coverage: "partial-serving-host",
                scope: stableScope,
                servingHostId: args.hostId,
              };
      }

      return seedPlainTerminalList(
        cache.getQueryData<PlainTerminalCollection>(mappedKey),
        normalizedResponse,
        requestContext ?? capturePlainTerminalProjectionBarrier(undefined),
      );
    },
  });

  // Base transport identity owns unmount/host/client/scope teardown.
  // Capability incarnation is handled by establishment below so a live-upgrade
  // can replace a terminally incompatible session on the same transport.
  useEffect(() => {
    return () => {
      const active = activeStreamRef.current;
      if (
        active !== null &&
        active.hostId === args.hostId &&
        active.scopeKey === scopeKey &&
        active.streamClient === args.streamClient &&
        active.transportKey === transportKey
      ) {
        active.release();
        activeStreamRef.current = null;
      }
    };
  }, [args.hostId, args.streamClient, scopeKey, transportKey]);

  // Capability gates initial establishment. Once established, registry
  // support/version churn in the same incarnation cannot replace the session.
  // A genuine incarnation change may retry even when the client's local
  // support registry still contains the prior incarnation's incompatibility.
  useEffect(() => {
    const streamClient = args.streamClient;
    const active = activeStreamRef.current;
    const sameBaseIdentity =
      active !== null &&
      active.hostId === args.hostId &&
      active.scopeKey === scopeKey &&
      active.streamClient === args.streamClient &&
      active.transportKey === transportKey;
    if (
      sameBaseIdentity &&
      active.capabilityIncarnation === args.capabilityIncarnation
    ) {
      return;
    }
    const genuineIncarnationChange =
      sameBaseIdentity &&
      active.capabilityIncarnation !== args.capabilityIncarnation;
    if (
      streamClient === null ||
      unaryCapability.status !== "capable" ||
      (!genuineIncarnationChange && streamSupport === "unsupported") ||
      (!genuineIncarnationChange && !streamVersionCompatible)
    ) {
      return;
    }
    if (active !== null) {
      active.release();
      activeStreamRef.current = null;
    }
    const release = acquireSharedPlainTerminalStream({
      queryClient,
      ownerKey: sharedStreamOwnerKey(args.hostId, stableScope),
      consumer: streamConsumer,
      streamClient,
      streamBinding: args.streamBinding ?? null,
      capabilityIncarnation: args.capabilityIncarnation,
      open: () => {
        let connectionEpisode = 0;
        let connectionPhase: "pre-open" | "open" | "closed" = "pre-open";
        let pendingSettlement: {
          readonly connectionEpisode: number;
          readonly snapshotEpoch: number;
        } | null = null;
        const scopesMatch = (state: PlainTerminalListState): boolean => {
          if (state.scope.kind === "independent") {
            return stableScope.kind === "independent";
          }
          return (
            stableScope.kind === "epic" &&
            stableScope.epicId === state.scope.epicId
          );
        };
        const settleIfReady = (): void => {
          const pending = pendingSettlement;
          if (
            pending === null ||
            connectionPhase !== "open" ||
            pending.connectionEpisode !== connectionEpisode
          ) {
            return;
          }
          const current =
            queryClient.getQueryData<PlainTerminalCollection>(queryKey);
          if (
            current?.snapshotEpoch !== pending.snapshotEpoch ||
            current.streamCompatibility !== "compatible" ||
            current.streamSnapshotFresh
          ) {
            return;
          }
          pendingSettlement = null;
          const acknowledgedTerminalIds =
            acknowledgedPlainTerminalPresentationIdsForScope(
              args.hostId,
              stableScope,
            );
          const settled = settlePlainTerminalSnapshot(current);
          queryClient.setQueryData<PlainTerminalCollection>(queryKey, settled);
          for (const terminalId of acknowledgedTerminalIds) {
            commitPlainTerminalSnapshotOmission({
              queryClient,
              queryKey,
              hostId: args.hostId,
              scope: stableScope,
              terminalId,
              snapshotEpoch: settled.snapshotEpoch,
            });
          }
        };
        return new PlainTerminalListStreamClient({
          wsStreamClient: streamClient,
          servingHostId: args.hostId,
          scope: stableScope,
          callbacks: {
            onState: (frame) => {
              // Remote LogicalStream delivers the current generation's first
              // frame immediately before its open transition. Accept that
              // replacement, but require the ensuing open before settlement.
              if (connectionPhase === "closed") return;
              if (!scopesMatch(frame.state)) return;
              const current =
                queryClient.getQueryData<PlainTerminalCollection>(queryKey);
              const next = replacePlainTerminalState(current, frame.state);
              queryClient.setQueryData<PlainTerminalCollection>(queryKey, next);
              pendingSettlement = {
                connectionEpisode,
                snapshotEpoch: next.snapshotEpoch,
              };
              settleIfReady();
            },
            onConnectionStatus: (status, reason) => {
              if (connectionPhase === "closed") return;
              if (status === "connecting" || status === "reconnecting") {
                connectionEpisode += 1;
                connectionPhase = "pre-open";
                pendingSettlement = null;
              } else if (status === "closed") {
                connectionEpisode += 1;
                connectionPhase = "closed";
                pendingSettlement = null;
              } else {
                connectionPhase = "open";
              }
              queryClient.setQueryData<PlainTerminalCollection>(
                queryKey,
                (current) =>
                  isMethodIncompatibleClose(reason)
                    ? markPlainTerminalStreamIncompatible(current)
                    : setPlainTerminalStreamStatus(current, status),
              );
              if (status === "open") settleIfReady();
            },
          },
        });
      },
    });
    activeStreamRef.current = {
      hostId: args.hostId,
      scopeKey,
      streamClient,
      transportKey,
      capabilityIncarnation: args.capabilityIncarnation,
      release,
    };
  }, [
    args.hostId,
    args.streamClient,
    args.streamBinding,
    args.capabilityIncarnation,
    queryClient,
    queryKey,
    streamSupport,
    streamVersionCompatible,
    scopeKey,
    stableScope,
    streamConsumer,
    transportKey,
    unaryCapability.status,
  ]);

  const collection = query.data;
  useRetainedPlainTerminalTombstoneReconciliation({
    hostId: args.hostId,
    queryKey,
    deletedRevisionByIdentity: collection?.deletedRevisionByIdentity,
  });
  const streamIncompatible =
    collection?.streamCompatibility === "incompatible" ||
    streamSupport === "unsupported" ||
    !streamVersionCompatible;
  const capability: PlainTerminalCapability = streamIncompatible
    ? { status: "legacy" }
    : unaryCapability;
  const canMutate = plainTerminalAuthorityCanMutate(capability, collection);

  return {
    hostId: args.hostId,
    scope: stableScope,
    capability,
    collection,
    terminals: plainTerminalCollectionValues(collection),
    coverage: collection?.coverage ?? null,
    servingHostId: collection?.servingHostId ?? null,
    canMutate,
    query,
  };
}

/** Host-lifetime-safe adapter for terminal tabs. */
export function useTabPlainTerminalAuthority(
  scope: PlainTerminalScope,
): PlainTerminalAuthorityResult {
  const hostId = useTabHostId();
  const client = useTabHostClient();
  const target = useHostDirectoryEntry(hostId);
  const auth = useStreamAuthRevalidator();
  const streamBinding = useHostStreamClientBindingFor(target, auth);
  return usePlainTerminalAuthority({
    hostId,
    scope,
    client,
    streamClient: streamBinding?.client ?? null,
    streamBinding,
    capabilityIncarnation: `${target?.version ?? "unknown"}\u0000${target?.websocketUrl ?? "unreachable"}`,
  });
}

/** Explicit-host adapter for non-tab surfaces such as the epic sidebar. */
export function useHostPlainTerminalAuthority(args: {
  readonly hostId: string;
  readonly scope: PlainTerminalScope;
}): PlainTerminalAuthorityResult {
  const target = useHostDirectoryEntry(args.hostId);
  const client = useHostClientFor(target);
  const auth = useStreamAuthRevalidator();
  const streamBinding = useHostStreamClientBindingFor(target, auth);
  return usePlainTerminalAuthority({
    hostId: args.hostId,
    scope: args.scope,
    client,
    streamClient: streamBinding?.client ?? null,
    streamBinding,
    capabilityIncarnation: `${target?.version ?? "unknown"}\u0000${target?.websocketUrl ?? "unreachable"}`,
  });
}
