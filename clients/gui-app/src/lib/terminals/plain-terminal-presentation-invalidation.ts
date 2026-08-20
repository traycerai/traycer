import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { PlainTerminalScope } from "@traycer/protocol/host/terminal/plain-schemas";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import type { PlainTerminalProjectionBarrier } from "@/lib/terminals/plain-terminal-authority";
import {
  adoptPlainTerminalDeletionUnary,
  deletePlainTerminal,
  type PlainTerminalCollection,
} from "@/lib/terminals/plain-terminal-authority";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  isHostEpicTerminalRef,
  isUnsupportedEpicTerminalRef,
  type EpicCanvasTileRef,
} from "@/stores/epics/canvas/types";
import { useLandingTerminalStore } from "@/stores/home/landing-terminal-store";

export type PlainTerminalDeletionEvidence =
  | {
      readonly kind: "stream";
      readonly revision: number;
    }
  | {
      readonly kind: "unary";
      readonly revision: number;
      readonly barrier: PlainTerminalProjectionBarrier;
    };

function acknowledgedTerminalId(
  ref: EpicCanvasTileRef | null | undefined,
  hostId: string,
  pendingCreateArtifactIds: ReadonlySet<string>,
): string | null {
  if (
    ref?.type !== "terminal" ||
    !isHostEpicTerminalRef(ref) ||
    ref.hostId !== hostId ||
    pendingCreateArtifactIds.has(ref.id)
  ) {
    return null;
  }
  return ref.id;
}

function addAcknowledgedTerminalId(
  terminalIds: Set<string>,
  ref: EpicCanvasTileRef | null | undefined,
  hostId: string,
  pendingCreateArtifactIds: ReadonlySet<string>,
): void {
  const terminalId = acknowledgedTerminalId(
    ref,
    hostId,
    pendingCreateArtifactIds,
  );
  if (terminalId !== null) terminalIds.add(terminalId);
}

/**
 * Returns host-acknowledged presentation identities in exactly one authority
 * scope. Snapshot absence proves deletion only for these canonical pointers;
 * legacy/import evidence and pending creates require explicit host evidence.
 */
export function acknowledgedPlainTerminalPresentationIdsForScope(
  hostId: string,
  scope: PlainTerminalScope,
): ReadonlySet<string> {
  const terminalIds = new Set<string>();
  if (scope.kind === "independent") {
    for (const tab of useLandingTerminalStore.getState().tabs) {
      const acknowledged =
        tab.hostId === hostId &&
        tab.hostAuthorityAcknowledged === true &&
        tab.pendingCreate !== true;
      if (acknowledged) {
        terminalIds.add(tab.sessionId);
      }
    }
    return terminalIds;
  }

  const epic = useEpicCanvasStore.getState();
  const pendingCreateArtifactIds = epic.pendingCreateArtifactIds;
  for (const tab of Object.values(epic.tabsById)) {
    if (tab?.epicId !== scope.epicId) continue;
    for (const ref of Object.values(
      epic.canvasByTabId[tab.tabId]?.tilesByInstanceId ?? {},
    )) {
      addAcknowledgedTerminalId(
        terminalIds,
        ref,
        hostId,
        pendingCreateArtifactIds,
      );
    }
    for (const payload of Object.values(
      epic.closedTilePayloadsByTabId[tab.tabId] ?? {},
    )) {
      addAcknowledgedTerminalId(
        terminalIds,
        payload?.node,
        hostId,
        pendingCreateArtifactIds,
      );
    }
  }
  return terminalIds;
}

function hasPlainTerminalPresentationRefs(
  hostId: string,
  terminalId: string,
): boolean {
  const epic = useEpicCanvasStore.getState();
  const live = Object.values(epic.canvasByTabId).some((canvas) =>
    Object.values(canvas?.tilesByInstanceId ?? {}).some(
      (ref) =>
        ref?.type === "terminal" &&
        !isUnsupportedEpicTerminalRef(ref) &&
        ref.hostId === hostId &&
        ref.id === terminalId,
    ),
  );
  if (live) return true;
  const closed = Object.values(epic.closedTilePayloadsByTabId).some((forTab) =>
    Object.values(forTab ?? {}).some((payload) => {
      const ref = payload?.node;
      return (
        ref?.type === "terminal" &&
        !isUnsupportedEpicTerminalRef(ref) &&
        ref.hostId === hostId &&
        ref.id === terminalId
      );
    }),
  );
  if (closed) return true;
  return useLandingTerminalStore
    .getState()
    .tabs.some((tab) => tab.hostId === hostId && tab.sessionId === terminalId);
}

/**
 * Removes every supported presentation pointer for one host-owned terminal.
 *
 * Durable terminal identity is shared across epic and independent surfaces,
 * so an authoritative deletion observed by either surface must invalidate
 * both stores. Unsupported future-authority refs remain presentation-only and
 * are deliberately left untouched.
 */
function removePlainTerminalPresentationRefs(
  hostId: string,
  terminalId: string,
): void {
  useEpicCanvasStore.getState().removeHostTerminalRefs(hostId, terminalId);
  useLandingTerminalStore.getState().removeHostTerminal(hostId, terminalId);
}

function fanOutPlainTerminalDeletionOnce(args: {
  readonly hostId: string;
  readonly terminalId: string;
}): boolean {
  if (!hasPlainTerminalPresentationRefs(args.hostId, args.terminalId)) {
    return false;
  }
  removePlainTerminalPresentationRefs(args.hostId, args.terminalId);
  return true;
}

/**
 * True when this revision is the collection's retained tombstone and has not
 * been overtaken by a newer live projection. Equal revision is conclusive
 * presentation evidence; a lower or raced revision is not.
 */
function deletionMatchesRetainedTombstone(
  collection: PlainTerminalCollection | undefined,
  terminalId: string,
  evidence: PlainTerminalDeletionEvidence,
): boolean {
  if (collection === undefined) return false;
  const retained = collection.deletedRevisionById[terminalId];
  if (retained === undefined || retained !== evidence.revision) return false;
  const existing = collection.terminalsById[terminalId];
  if (existing !== undefined && existing.record.revision > evidence.revision) {
    return false;
  }
  if (evidence.kind === "unary") {
    const streamAdvanced =
      (collection.lastStreamSequenceById[terminalId] ?? -1) >
      evidence.barrier.projectionSequence;
    if (
      streamAdvanced &&
      existing !== undefined &&
      existing.record.revision >= evidence.revision
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Sweeps current supported refs for a Query tombstone that was already
 * accepted. Presentation can hydrate after the first Query transition, so
 * this is not a new projection.
 */
export function consumeRetainedPlainTerminalTombstone(args: {
  readonly queryClient: QueryClient;
  readonly queryKey: QueryKey;
  readonly hostId: string;
  readonly terminalId: string;
}): boolean {
  const collection = args.queryClient.getQueryData<PlainTerminalCollection>(
    args.queryKey,
  );
  const revision = collection?.deletedRevisionById[args.terminalId];
  if (collection === undefined || revision === undefined) return false;
  if (
    collection.pendingPresentationDeletionRevisionById[args.terminalId] !==
    undefined
  ) {
    return false;
  }
  const existing = collection.terminalsById[args.terminalId];
  if (existing !== undefined && existing.record.revision > revision) {
    return false;
  }
  return fanOutPlainTerminalDeletionOnce({
    hostId: args.hostId,
    terminalId: args.terminalId,
  });
}

/**
 * Sweeps every retained Query tombstone against current live and closed
 * presentation. Used by scope-level reconciliation so a late closed-only
 * epic payload does not need a later unary response.
 */
export function reconcileRetainedPlainTerminalTombstones(args: {
  readonly queryClient: QueryClient;
  readonly queryKey: QueryKey;
  readonly hostId: string;
}): boolean {
  const collection = args.queryClient.getQueryData<PlainTerminalCollection>(
    args.queryKey,
  );
  if (collection === undefined) return false;
  let swept = false;
  for (const terminalId of Object.keys(collection.deletedRevisionById)) {
    if (
      consumeRetainedPlainTerminalTombstone({
        queryClient: args.queryClient,
        queryKey: args.queryKey,
        hostId: args.hostId,
        terminalId,
      })
    ) {
      swept = true;
    }
  }
  return swept;
}

function epicPlainTerminalQueryKey(hostId: string, epicId: string): QueryKey {
  return hostQueryKeys.plainTerminals(hostId, { kind: "epic", epicId });
}

/**
 * True when a retained epic tombstone still forbids restoring this closed
 * terminal. A newer live projection overtaking the tombstone does not block.
 * A still-deferred presentation obligation blocks restore without consuming.
 */
export function retainedPlainTerminalTombstoneBlocksClosedRestore(args: {
  readonly queryClient: QueryClient;
  readonly epicId: string;
  readonly node: EpicCanvasTileRef;
}): boolean {
  if (
    args.node.type !== "terminal" ||
    isUnsupportedEpicTerminalRef(args.node)
  ) {
    return false;
  }
  const collection = args.queryClient.getQueryData<PlainTerminalCollection>(
    epicPlainTerminalQueryKey(args.node.hostId, args.epicId),
  );
  const revision = collection?.deletedRevisionById[args.node.id];
  if (collection === undefined || revision === undefined) return false;
  const existing = collection.terminalsById[args.node.id];
  return existing === undefined || existing.record.revision <= revision;
}

/**
 * Synchronous closed-payload restore gate. Rejects a retained tombstone
 * without requiring a mounted observer. Consumes when the obligation is
 * settled; leaves presentation untouched while fanout is still deferred.
 * Returns true when the caller must not restore.
 */
export function rejectClosedPlainTerminalRestore(args: {
  readonly queryClient: QueryClient;
  readonly epicId: string;
  readonly node: EpicCanvasTileRef;
}): boolean {
  if (!retainedPlainTerminalTombstoneBlocksClosedRestore(args)) {
    return false;
  }
  if (args.node.type !== "terminal") return true;
  consumeRetainedPlainTerminalTombstone({
    queryClient: args.queryClient,
    queryKey: epicPlainTerminalQueryKey(args.node.hostId, args.epicId),
    hostId: args.node.hostId,
    terminalId: args.node.id,
  });
  return true;
}

/**
 * The sole revisioned-deletion commit boundary. Query state is written before
 * presentation effects. A stale or overtaken revision is a no-op. An equal
 * retained tombstone does not advance Query sequence, but still sweeps any
 * supported refs that hydrated after the first accepted transition.
 * Initialization may defer the fanout until the snapshot prefix is settled.
 */
export function commitPlainTerminalDeletion(args: {
  readonly queryClient: QueryClient;
  readonly queryKey: QueryKey;
  readonly hostId: string;
  readonly terminalId: string;
  readonly evidence: PlainTerminalDeletionEvidence;
  readonly deferPresentation: boolean;
}): boolean {
  const current = args.queryClient.getQueryData<PlainTerminalCollection>(
    args.queryKey,
  );
  const next =
    args.evidence.kind === "stream"
      ? deletePlainTerminal(current, args.terminalId, args.evidence.revision)
      : adoptPlainTerminalDeletionUnary(
          current,
          args.terminalId,
          args.evidence.revision,
          args.evidence.barrier,
        );
  if (next === current) {
    if (
      args.deferPresentation ||
      !deletionMatchesRetainedTombstone(current, args.terminalId, args.evidence)
    ) {
      return false;
    }
    return fanOutPlainTerminalDeletionOnce({
      hostId: args.hostId,
      terminalId: args.terminalId,
    });
  }
  const revision = args.evidence.revision;
  let committed = next;
  if (args.deferPresentation) {
    committed = {
      ...next,
      pendingPresentationDeletionRevisionById: {
        ...next.pendingPresentationDeletionRevisionById,
        [args.terminalId]: revision,
      },
    };
  } else if (
    next.pendingPresentationDeletionRevisionById[args.terminalId] !== undefined
  ) {
    const pendingPresentationDeletionRevisionById = {
      ...next.pendingPresentationDeletionRevisionById,
    };
    delete pendingPresentationDeletionRevisionById[args.terminalId];
    committed = { ...next, pendingPresentationDeletionRevisionById };
  }
  args.queryClient.setQueryData<PlainTerminalCollection>(
    args.queryKey,
    committed,
  );
  if (!args.deferPresentation) {
    fanOutPlainTerminalDeletionOnce({
      hostId: args.hostId,
      terminalId: args.terminalId,
    });
  }
  return true;
}

/**
 * Discharges one accepted deletion after the snapshot and buffered prefix for
 * the current epoch have settled. The obligation lives in Query state so a
 * reconnect or replacement stream cannot strand presentation references.
 */
export function commitPlainTerminalDeferredDeletion(args: {
  readonly queryClient: QueryClient;
  readonly queryKey: QueryKey;
  readonly hostId: string;
  readonly terminalId: string;
  readonly snapshotEpoch: number;
}): boolean {
  const collection = args.queryClient.getQueryData<PlainTerminalCollection>(
    args.queryKey,
  );
  const revision =
    collection?.pendingPresentationDeletionRevisionById[args.terminalId];
  if (
    collection?.streamSnapshotFresh !== true ||
    collection.snapshotEpoch !== args.snapshotEpoch ||
    revision === undefined ||
    collection.terminalsById[args.terminalId] !== undefined ||
    (collection.deletedRevisionById[args.terminalId] ?? -1) < revision
  ) {
    return false;
  }

  const pendingPresentationDeletionRevisionById = {
    ...collection.pendingPresentationDeletionRevisionById,
  };
  delete pendingPresentationDeletionRevisionById[args.terminalId];
  args.queryClient.setQueryData<PlainTerminalCollection>(args.queryKey, {
    ...collection,
    pendingPresentationDeletionRevisionById,
  });
  fanOutPlainTerminalDeletionOnce({
    hostId: args.hostId,
    terminalId: args.terminalId,
  });
  return true;
}

/**
 * Commits one absence proved by a settled snapshot initialization epoch.
 *
 * Snapshot absence proves deletion only for host-acknowledged pointers: an
 * unacknowledged ref or a pending create is legitimately absent from the
 * host's snapshot, so absence alone must never destroy it. That precondition
 * is enforced here through `acknowledgedPlainTerminalPresentationIdsForScope`
 * rather than left to the caller, because both exports are public and a caller
 * that passes a raw terminal id would otherwise delete a user's pending
 * terminal.
 */
export function commitPlainTerminalSnapshotOmission(args: {
  readonly queryClient: QueryClient;
  readonly queryKey: QueryKey;
  readonly hostId: string;
  readonly scope: PlainTerminalScope;
  readonly terminalId: string;
  readonly snapshotEpoch: number;
}): boolean {
  const collection = args.queryClient.getQueryData<PlainTerminalCollection>(
    args.queryKey,
  );
  if (
    collection?.streamSnapshotFresh !== true ||
    collection.snapshotEpoch !== args.snapshotEpoch ||
    collection.terminalsById[args.terminalId] !== undefined
  ) {
    return false;
  }
  if (
    !acknowledgedPlainTerminalPresentationIdsForScope(
      args.hostId,
      args.scope,
    ).has(args.terminalId)
  ) {
    return false;
  }
  return fanOutPlainTerminalDeletionOnce({
    hostId: args.hostId,
    terminalId: args.terminalId,
  });
}
