/**
 * Display overlay beside the slices, folded in before projectTreeSlice.
 * Rollback is dropping the patch; do not write the captured baseline back.
 */
import type {
  ArtifactsSlice,
  ChatsSlice,
  EpicHeader,
  TerminalAgentsSlice,
} from "./types";

/**
 * A rename in flight. `nodeId` may name an artifact, a chat or a terminal agent - the overlay does
 * not care which plane the row lives on, which is the point.
 */
export interface PendingRename {
  readonly kind: "rename";
  readonly requestId: string;
  readonly nodeId: string;
  /** The title the user asked for. */
  readonly title: string;
  /**
   * The AUTHORITATIVE title at the moment this mutation was stamped - read from the projection,
   * never from a previous overlay.
   */
  readonly baseline: string;
  /** True once this mutation's RPC ACKED. A landed entry is no longer pending */
  readonly landed: boolean;
}

/** An epic-header title change in flight (the tab strip / mobile header). */
export interface PendingEpicTitle {
  readonly kind: "epic-title";
  readonly requestId: string;
  readonly title: string;
  readonly baseline: string;
  /** See {@link PendingRename.landed}. */
  readonly landed: boolean;
}

/**
 * An artifact reparent in flight. Applied to the row's `parentId` before the
 * tree is built, so the sidebar re-parents synchronously.
 */
export interface PendingReparent {
  readonly kind: "reparent";
  readonly requestId: string;
  readonly nodeId: string;
  readonly parentId: string | null;
  readonly baseline: string | null;
  /** See {@link PendingRename.landed}. */
  readonly landed: boolean;
}

/** Ticket/story status command projected over the artifact row. */
export interface PendingArtifactStatus {
  readonly kind: "status";
  readonly requestId: string;
  readonly nodeId: string;
  readonly status: number;
  readonly baseline: number | null;
  readonly landed: boolean;
}

/** Artifact subtree deletion. Descendants are derived from the base slice. */
export interface PendingArtifactDelete {
  readonly kind: "delete";
  readonly requestId: string;
  readonly nodeId: string;
  readonly baseline: true;
  readonly landed: boolean;
}

export type PendingMetadataMutation =
  | PendingRename
  | PendingEpicTitle
  | PendingReparent
  | PendingArtifactStatus
  | PendingArtifactDelete;

export type PendingMetadataValue = string | number | boolean | null;

/** Every mutation this client has stamped and not yet finished with, keyed by client request id. */
export type PendingMetadataOverlay = ReadonlyMap<
  string,
  PendingMetadataMutation
>;

/** The shared "nothing in flight" identity. */
export const EMPTY_PENDING_OVERLAY: PendingMetadataOverlay = new Map<
  string,
  PendingMetadataMutation
>();

/** The node a mutation patches, or `null` for the epic header. */
function mutationNodeId(mutation: PendingMetadataMutation): string | null {
  return mutation.kind === "epic-title" ? null : mutation.nodeId;
}

/**
 * The value a mutation is asking for, in the shape the row carries it. Renames
 * and the epic title patch a `string`; a reparent patches `string | null`.
 */
function mutationTarget(
  mutation: PendingMetadataMutation,
): PendingMetadataValue {
  switch (mutation.kind) {
    case "reparent":
      return mutation.parentId;
    case "rename":
    case "epic-title":
      return mutation.title;
    case "status":
      return mutation.status;
    case "delete":
      return false;
  }
}

interface ResolvedPendingChain {
  readonly value: PendingMetadataValue;
  readonly changed: boolean;
  /**
   * Every entry in this chain is finished business and the whole chain can be forgotten: the row
   * caught up to the last acked value, or the row moved somewhere no anchor explains - a peer
   */
  readonly dead: boolean;
  readonly deadReason: "echo" | "superseded" | null;
}

/**
 * Decide what the display value for one field should be, given the authoritative value and the
 * mutations stamped for it.
 */
function resolvePendingChain(
  authoritative: PendingMetadataValue,
  chain: readonly PendingMetadataMutation[],
): ResolvedPendingChain {
  if (chain.length === 0) {
    return {
      value: authoritative,
      changed: false,
      dead: false,
      deadReason: null,
    };
  }
  const baseline = chain[0].baseline;
  const pending = chain.filter((mutation) => !mutation.landed);
  const landedTargets = chain
    .filter((mutation) => mutation.landed)
    .map(mutationTarget);
  if (pending.length > 0) {
    const anchored =
      authoritative === baseline || landedTargets.includes(authoritative);
    if (!anchored) {
      return {
        value: authoritative,
        changed: false,
        dead: true,
        deadReason: "superseded",
      };
    }
    // The LAST-STAMPED target, not the last still-pending one: ACKs settle out of order, and filtering
    // landed entries out of display selection walks the UI backward when the newest intent acks first
    const value = mutationTarget(chain[chain.length - 1]);
    return {
      value,
      changed: value !== authoritative,
      dead: false,
      deadReason: null,
    };
  }
  const lastLanded = landedTargets[landedTargets.length - 1];
  if (authoritative === lastLanded) {
    return {
      value: authoritative,
      changed: false,
      dead: true,
      deadReason: "echo",
    };
  }
  if (authoritative === baseline) {
    return {
      value: lastLanded,
      changed: true,
      dead: false,
      deadReason: null,
    };
  }
  return {
    value: authoritative,
    changed: false,
    dead: true,
    deadReason: "superseded",
  };
}

/** Mutations of one kind for one node, in the order they were stamped. */
function chainFor(
  overlay: PendingMetadataOverlay,
  kind: PendingMetadataMutation["kind"],
  nodeId: string | null,
): readonly PendingMetadataMutation[] {
  const chain: PendingMetadataMutation[] = [];
  for (const mutation of overlay.values()) {
    if (mutation.kind !== kind) continue;
    if (mutationNodeId(mutation) !== nodeId) continue;
    chain.push(mutation);
  }
  return chain;
}

/**
 * Node ids carrying at least one RETAINED mutation of the given kind - landed or not; "pending" is
 * reserved for un-landed (see `pendingMutationCount`).
 */
function nodesWithMutations(
  overlay: PendingMetadataOverlay,
  kind: PendingMetadataMutation["kind"],
): readonly string[] {
  const ids: string[] = [];
  for (const mutation of overlay.values()) {
    if (mutation.kind !== kind) continue;
    const id = mutationNodeId(mutation);
    if (id === null || ids.includes(id)) continue;
    ids.push(id);
  }
  return ids;
}

/** The row fields the overlay patches, shared by all three slices. */
interface OverlayPatchableRow {
  readonly title: string;
  readonly parentId: string | null;
}

interface OverlayPatchableSlice<Row extends OverlayPatchableRow> {
  readonly byId: Readonly<Record<string, Row>>;
  readonly allIds: readonly string[];
}

/**
 * One applier for all three slices - artifacts, chats and terminal agents patch the same two
 * fields under the same chain rules, and three hand-copied bodies is how the rules drift apart.
 */
function applyPendingOverlayToSlice<Row extends OverlayPatchableRow>(
  slice: OverlayPatchableSlice<Row>,
  overlay: PendingMetadataOverlay,
): OverlayPatchableSlice<Row> {
  if (overlay.size === 0) return slice;
  let byId: Record<string, Row> | null = null;
  const touched = new Set<string>([
    ...nodesWithMutations(overlay, "rename"),
    ...nodesWithMutations(overlay, "reparent"),
  ]);
  for (const id of touched) {
    // `Object.hasOwn`, not an `=== undefined` check on the read: `byId` is a `Record`, so the index
    // signature types the read as always-present and the null check lints as impossible.
    if (!Object.hasOwn(slice.byId, id)) continue;
    const row = slice.byId[id];
    const title = resolvePendingChain(
      row.title,
      chainFor(overlay, "rename", id),
    );
    const parent = resolvePendingChain(
      row.parentId,
      chainFor(overlay, "reparent", id),
    );
    if (!title.changed && !parent.changed) continue;
    byId ??= { ...slice.byId };
    // `Object.assign` rather than an object spread: spreading a generic `Row` and overriding two
    // properties types as a fresh object literal, not as `Row`, while the assign form's intersection
    byId[id] = Object.assign({}, row, {
      title:
        title.changed && typeof title.value === "string"
          ? title.value
          : row.title,
      parentId:
        parent.changed &&
        (parent.value === null || typeof parent.value === "string")
          ? parent.value
          : row.parentId,
    });
  }
  if (byId === null) return slice;
  return { byId, allIds: slice.allIds };
}

/** `metadata.byId` with pending status overrides applied, or `null` if none landed. */
function applyPendingStatusOverrides(
  metadata: ArtifactsSlice,
  overlay: PendingMetadataOverlay,
): Record<string, ArtifactsSlice["byId"][string]> | null {
  let byId: Record<string, ArtifactsSlice["byId"][string]> | null = null;
  for (const id of nodesWithMutations(overlay, "status")) {
    if (!Object.hasOwn(metadata.byId, id)) continue;
    const row = metadata.byId[id];
    const status = resolvePendingChain(
      row.status,
      chainFor(overlay, "status", id),
    );
    if (
      !status.changed ||
      (status.value !== null && typeof status.value !== "number")
    ) {
      continue;
    }
    byId ??= { ...metadata.byId };
    byId[id] = { ...row, status: status.value };
  }
  return byId;
}

/**
 * Ids with a pending, unlanded delete, plus everything that cascades under them (a tombstoned
 * parent removes every descendant, discovered to a fixed point since `metadata.allIds` carries no
 */
function pendingArtifactRemovals(
  metadata: ArtifactsSlice,
  overlay: PendingMetadataOverlay,
): Set<string> {
  const removed = new Set<string>();
  for (const id of nodesWithMutations(overlay, "delete")) {
    const present = Object.hasOwn(metadata.byId, id);
    const deletion = resolvePendingChain(
      present,
      chainFor(overlay, "delete", id),
    );
    if (deletion.value === false) removed.add(id);
  }
  let discovered = true;
  while (discovered) {
    discovered = false;
    for (const id of metadata.allIds) {
      if (removed.has(id)) continue;
      const row = metadata.byId[id];
      if (row.parentId !== null && removed.has(row.parentId)) {
        removed.add(id);
        discovered = true;
      }
    }
  }
  return removed;
}

/** `artifacts` with pending renames and reparents applied. */
export function applyPendingOverlayToArtifacts(
  artifacts: ArtifactsSlice,
  overlay: PendingMetadataOverlay,
): ArtifactsSlice {
  const metadata = applyPendingOverlayToSlice(artifacts, overlay);
  let byId = applyPendingStatusOverrides(metadata, overlay);

  const removed = pendingArtifactRemovals(metadata, overlay);
  if (removed.size > 0) {
    byId ??= { ...metadata.byId };
    for (const id of removed) delete byId[id];
  }

  if (byId === null) return metadata;
  return {
    byId,
    allIds:
      removed.size === 0
        ? metadata.allIds
        : metadata.allIds.filter((id) => !removed.has(id)),
  };
}

/** `chats` with pending renames and reparents applied. */
export function applyPendingOverlayToChats(
  chats: ChatsSlice,
  overlay: PendingMetadataOverlay,
): ChatsSlice {
  return applyPendingOverlayToSlice(chats, overlay);
}

/** `tuiAgents` with pending renames and reparents applied. */
export function applyPendingOverlayToTuiAgents(
  tuiAgents: TerminalAgentsSlice,
  overlay: PendingMetadataOverlay,
): TerminalAgentsSlice {
  return applyPendingOverlayToSlice(tuiAgents, overlay);
}

/** The epic header with a pending title change applied. */
export function applyPendingOverlayToEpicHeader(
  epic: EpicHeader,
  overlay: PendingMetadataOverlay,
): EpicHeader {
  if (overlay.size === 0) return epic;
  const resolved = resolvePendingChain(
    epic.title,
    chainFor(overlay, "epic-title", null),
  );
  if (!resolved.changed || typeof resolved.value !== "string") return epic;
  return { ...epic, title: resolved.value };
}

/**
 * How many mutations are genuinely in flight - stamped and not yet acked. LANDED entries are
 * excluded: the host has committed them, so nothing about them is at risk on quit.
 */
export function pendingMutationCount(overlay: PendingMetadataOverlay): number {
  let count = 0;
  for (const mutation of overlay.values()) {
    if (!mutation.landed) count += 1;
  }
  return count;
}

/** The pre-overlay union slices a chain's authoritative value is read from. */
export interface PendingOverlayAuthoritativeState {
  readonly artifacts: ArtifactsSlice;
  readonly chats: ChatsSlice;
  readonly tuiAgents: TerminalAgentsSlice;
  readonly epicTitle: string | null;
}

/** The row field a chain patches, read from whichever slice holds the node. */
function authoritativeValueFor(
  state: PendingOverlayAuthoritativeState,
  kind: PendingMetadataMutation["kind"],
  nodeId: string | null,
): { readonly found: boolean; readonly value: PendingMetadataValue } {
  if (kind === "epic-title") return { found: true, value: state.epicTitle };
  if (nodeId === null) return { found: false, value: null };
  if (kind === "delete") {
    return {
      found: true,
      value: Object.hasOwn(state.artifacts.byId, nodeId),
    };
  }
  if (kind === "status") {
    if (!Object.hasOwn(state.artifacts.byId, nodeId)) {
      return { found: false, value: null };
    }
    return { found: true, value: state.artifacts.byId[nodeId].status };
  }
  for (const byId of [
    state.artifacts.byId,
    state.chats.byId,
    state.tuiAgents.byId,
  ]) {
    if (!Object.hasOwn(byId, nodeId)) continue;
    const row = byId[nodeId];
    return {
      found: true,
      value: kind === "reparent" ? row.parentId : row.title,
    };
  }
  return { found: false, value: null };
}

export interface DeadPendingMutation {
  readonly requestId: string;
  readonly outcome: "echo" | "superseded";
}

/**
 * Request ids of every chain that is finished business against these authoritative slices: a
 * landed-only chain whose row caught up to the last acked value, ANY chain whose row moved
 */
export function collectDeadPendingMutations(
  overlay: PendingMetadataOverlay,
  state: PendingOverlayAuthoritativeState,
): readonly string[] {
  const detailed = collectDeadPendingMutationOutcomes(overlay, state);
  return detailed.length === 0
    ? EMPTY_REQUEST_IDS
    : detailed.map((entry) => entry.requestId);
}

export function collectDeadPendingMutationOutcomes(
  overlay: PendingMetadataOverlay,
  state: PendingOverlayAuthoritativeState,
): readonly DeadPendingMutation[] {
  if (overlay.size === 0) return EMPTY_DEAD_MUTATIONS;
  const seen = new Set<string>();
  const dead: DeadPendingMutation[] = [];
  for (const mutation of overlay.values()) {
    const nodeId = mutationNodeId(mutation);
    const chainKey = `${mutation.kind}:${nodeId ?? ""}`;
    if (seen.has(chainKey)) continue;
    seen.add(chainKey);
    const chain = chainFor(overlay, mutation.kind, nodeId);
    const authoritative = authoritativeValueFor(state, mutation.kind, nodeId);
    const resolved = authoritative.found
      ? resolvePendingChain(authoritative.value, chain)
      : null;
    // A vanished node is dead the same way a caught-up one is: there is no
    // row left for the patch to apply to, and no RPC outcome still owed.
    if (resolved === null || resolved.dead) {
      const outcome = resolved?.deadReason ?? "superseded";
      for (const entry of chain) {
        dead.push({ requestId: entry.requestId, outcome });
      }
    }
  }
  return dead.length === 0 ? EMPTY_DEAD_MUTATIONS : dead;
}

const EMPTY_REQUEST_IDS: readonly string[] = Object.freeze([]);
const EMPTY_DEAD_MUTATIONS: readonly DeadPendingMutation[] = Object.freeze([]);
