import type { SchemaVersion } from "@traycer/protocol/framework/index";
import {
  PLAIN_TERMINAL_FAMILY_VERSION,
  PLAIN_TERMINAL_LOCAL_FAMILY_VERSION,
} from "@traycer/protocol/host/terminal/plain-contracts";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type {
  ImportLegacyPlainTerminalRequest,
  ImportLegacyPlainTerminalResponse,
  PlainTerminalFleetIdentity,
  PlainTerminalListCoverage,
  PlainTerminalListState,
  PlainTerminalProjection,
  PlainTerminalScope,
} from "@traycer/protocol/host/terminal/plain-schemas";
import { plainTerminalFleetIdentityKey } from "@traycer/protocol/host/terminal/plain-schemas";
import { terminalSessionTitle } from "@/lib/terminals/terminal-title";

export const PLAIN_TERMINAL_RPC_METHODS = [
  "terminal.plain.create",
  "terminal.plain.list",
  "terminal.plain.rename",
  "terminal.plain.ensureRunning",
  "terminal.plain.close",
  "terminal.plain.importLegacy",
] as const;

export type PlainTerminalRpcMethod =
  (typeof PLAIN_TERMINAL_RPC_METHODS)[number];

export const PLAIN_TERMINAL_STREAM_METHOD =
  "terminal.plain.subscribeList" as const;

export type PlainTerminalCapability =
  | { readonly status: "unknown" }
  | { readonly status: "legacy" }
  | {
      readonly status: "capable";
      readonly schemaVersion: SchemaVersion;
    };

export type PlainTerminalTopology = "local" | "fleet";

export function plainTerminalCapabilityTopology(
  capability: PlainTerminalCapability,
): PlainTerminalTopology | null {
  if (capability.status !== "capable") return null;
  return capability.schemaVersion.major ===
    PLAIN_TERMINAL_LOCAL_FAMILY_VERSION.major
    ? "local"
    : "fleet";
}

/**
 * Resolves the optional family as a unit. The frozen v1 family is local-only
 * durable authority; v2.1 is fleet authority. A partial mix is legacy.
 */
export function resolvePlainTerminalCapability(input: {
  readonly manifestKnown: boolean;
  readonly versionFor: (method: PlainTerminalRpcMethod) => SchemaVersion | null;
}): PlainTerminalCapability {
  if (!input.manifestKnown) return { status: "unknown" };
  for (const candidate of [
    PLAIN_TERMINAL_FAMILY_VERSION,
    PLAIN_TERMINAL_LOCAL_FAMILY_VERSION,
  ]) {
    let matches = true;
    for (const method of PLAIN_TERMINAL_RPC_METHODS) {
      const version = input.versionFor(method);
      if (
        version === null ||
        version.major !== candidate.major ||
        version.minor !== candidate.minor
      ) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return { status: "capable", schemaVersion: candidate };
    }
  }
  return { status: "legacy" };
}

export function plainTerminalCollectionIdentityKey(
  hostId: string,
  terminalId: string,
): string {
  return plainTerminalFleetIdentityKey({ hostId, terminalId });
}

export function getPlainTerminal(
  collection: PlainTerminalCollection | undefined,
  hostId: string,
  terminalId: string,
): PlainTerminalProjection | undefined {
  return collection?.terminalsByIdentity[
    plainTerminalCollectionIdentityKey(hostId, terminalId)
  ];
}

export interface PlainTerminalCollection {
  /**
   * Current renderable authority keyed by canonical `(hostId, terminalId)`.
   * Replacement states replace this map atomically; it is never a union with
   * a previous complete snapshot.
   */
  readonly terminalsByIdentity: Readonly<
    Partial<Record<string, PlainTerminalProjection>>
  >;
  /**
   * Explicit lifetime-delete revisions only. Host withdrawal is absence from
   * a later replacement state and must not write these.
   */
  readonly deletedRevisionByIdentity: Readonly<Partial<Record<string, number>>>;
  /** Accepted unary deletions whose presentation sweep awaits settlement. */
  readonly pendingPresentationDeletionRevisionByIdentity: Readonly<
    Partial<Record<string, number>>
  >;
  readonly coverage: PlainTerminalListCoverage | null;
  readonly scope: PlainTerminalScope | null;
  readonly servingHostId: string | null;
  /** Monotonic client-side order for accepted stream/unary projections. */
  readonly projectionSequence: number;
  /** Monotonic count of accepted replacement states. */
  readonly snapshotEpoch: number;
  /** Last accepted stream projection sequence for each fleet identity. */
  readonly lastStreamSequenceByIdentity: Readonly<
    Partial<Record<string, number>>
  >;
  readonly streamStatus: StreamConnectionStatus | null;
  readonly streamCompatibility: "unknown" | "compatible" | "incompatible";
  /** True only after an accepted replacement state in the current episode. */
  readonly streamSnapshotFresh: boolean;
}

export interface PlainTerminalProjectionBarrier {
  readonly projectionSequence: number;
  readonly snapshotEpoch: number;
}

export function emptyPlainTerminalCollection(): PlainTerminalCollection {
  return {
    terminalsByIdentity: {},
    deletedRevisionByIdentity: {},
    pendingPresentationDeletionRevisionByIdentity: {},
    coverage: null,
    scope: null,
    servingHostId: null,
    projectionSequence: 0,
    snapshotEpoch: 0,
    lastStreamSequenceByIdentity: {},
    streamStatus: null,
    streamCompatibility: "unknown",
    streamSnapshotFresh: false,
  };
}

function scopesEqual(
  left: PlainTerminalScope,
  right: PlainTerminalScope,
): boolean {
  if (left.kind === "independent") {
    return right.kind === "independent";
  }
  return right.kind === "epic" && right.epicId === left.epicId;
}

function servingHostIdForState(state: PlainTerminalListState): string | null {
  return state.coverage === "partial-serving-host" ? state.servingHostId : null;
}

function identityKeyForProjection(terminal: PlainTerminalProjection): string {
  return plainTerminalCollectionIdentityKey(
    terminal.record.hostId,
    terminal.record.terminalId,
  );
}

function identityKeyFor(
  identity: Pick<PlainTerminalFleetIdentity, "hostId" | "terminalId">,
): string {
  return plainTerminalCollectionIdentityKey(
    identity.hostId,
    identity.terminalId,
  );
}

/** Captured immediately before a unary request is dispatched. */
export function capturePlainTerminalProjectionBarrier(
  collection: PlainTerminalCollection | undefined,
): PlainTerminalProjectionBarrier {
  return {
    projectionSequence: collection?.projectionSequence ?? 0,
    snapshotEpoch: collection?.snapshotEpoch ?? 0,
  };
}

/**
 * Atomically replaces the renderable collection with a schema-checked state.
 * A partial-serving-host state keeps only the serving-host slice; a previous
 * complete snapshot is never retained or promoted.
 */
export function replacePlainTerminalState(
  current: PlainTerminalCollection | undefined,
  state: PlainTerminalListState,
): PlainTerminalCollection {
  const base = current ?? emptyPlainTerminalCollection();
  const nextSequence = base.projectionSequence + 1;
  const terminalsByIdentity: Record<string, PlainTerminalProjection> = {};
  const lastStreamSequenceByIdentity: Record<string, number> = {};
  const pendingPresentationDeletionRevisionByIdentity = {
    ...base.pendingPresentationDeletionRevisionByIdentity,
  };
  for (const terminal of state.terminals) {
    const key = identityKeyForProjection(terminal);
    const deletedRevision = base.deletedRevisionByIdentity[key];
    if (
      deletedRevision !== undefined &&
      deletedRevision >= terminal.record.revision
    ) {
      continue;
    }
    terminalsByIdentity[key] = terminal;
    lastStreamSequenceByIdentity[key] = nextSequence;
    delete pendingPresentationDeletionRevisionByIdentity[key];
  }
  return {
    ...base,
    terminalsByIdentity,
    pendingPresentationDeletionRevisionByIdentity,
    coverage: state.coverage,
    scope: state.scope,
    servingHostId: servingHostIdForState(state),
    projectionSequence: nextSequence,
    snapshotEpoch: base.snapshotEpoch + 1,
    lastStreamSequenceByIdentity,
    streamCompatibility: "compatible",
    streamSnapshotFresh: false,
  };
}

function inferReplacementState(
  current: PlainTerminalCollection | undefined,
  terminals: readonly PlainTerminalProjection[],
): PlainTerminalListState {
  let inferredScope: PlainTerminalScope;
  const firstTerminal = terminals.at(0);
  if (current?.scope !== null && current?.scope !== undefined) {
    inferredScope = current.scope;
  } else if (firstTerminal !== undefined) {
    inferredScope = firstTerminal.record.scope;
  } else {
    inferredScope = { kind: "independent" };
  }
  if (inferredScope.kind === "independent") {
    return {
      coverage: "complete-local",
      scope: { kind: "independent" },
      terminals: [...terminals],
    };
  }
  return {
    coverage: "complete-fleet",
    scope: inferredScope,
    terminals: [...terminals],
  };
}

/** Test and unary helper: treat `terminals` as a complete replacement state. */
export function replacePlainTerminalSnapshot(
  current: PlainTerminalCollection | undefined,
  terminals: readonly PlainTerminalProjection[],
): PlainTerminalCollection {
  return replacePlainTerminalState(
    current,
    inferReplacementState(current, terminals),
  );
}

/** Marks the snapshot plus its buffered mutation prefix as fully applied. */
export function settlePlainTerminalSnapshot(
  current: PlainTerminalCollection | undefined,
): PlainTerminalCollection {
  const base = current ?? emptyPlainTerminalCollection();
  if (base.streamSnapshotFresh) return base;
  return { ...base, streamSnapshotFresh: true };
}

export function markPlainTerminalStreamIncompatible(
  current: PlainTerminalCollection | undefined,
): PlainTerminalCollection {
  const base = current ?? emptyPlainTerminalCollection();
  return {
    ...base,
    streamCompatibility: "incompatible",
    streamSnapshotFresh: false,
  };
}

/**
 * Unary list seeds the collection but never creates stream freshness.
 * A replacement state accepted after the request barrier dominates the
 * entire delayed response. Independent complete-local states stay isolated
 * from fleet coverage rather than merging into it.
 */
export function seedPlainTerminalList(
  current: PlainTerminalCollection | undefined,
  state: PlainTerminalListState,
  barrier: PlainTerminalProjectionBarrier,
): PlainTerminalCollection {
  const base = current ?? emptyPlainTerminalCollection();
  if (base.snapshotEpoch > barrier.snapshotEpoch) return base;
  if (base.scope !== null && !scopesEqual(base.scope, state.scope)) {
    return base;
  }
  const replaced = replacePlainTerminalState(base, state);
  return {
    ...replaced,
    streamCompatibility: base.streamCompatibility,
    streamSnapshotFresh: base.streamSnapshotFresh,
  };
}

/**
 * Adopts one projection by fleet identity. Used by unary mutation results
 * and tests; stream collection updates use replacement states instead.
 */
export function upsertPlainTerminal(
  current: PlainTerminalCollection | undefined,
  terminal: PlainTerminalProjection,
): PlainTerminalCollection {
  const base = current ?? emptyPlainTerminalCollection();
  const key = identityKeyForProjection(terminal);
  const deletedRevision = base.deletedRevisionByIdentity[key];
  if (
    deletedRevision !== undefined &&
    deletedRevision >= terminal.record.revision
  ) {
    return base;
  }
  const existing = base.terminalsByIdentity[key];
  if (
    existing !== undefined &&
    existing.record.revision > terminal.record.revision
  ) {
    return base;
  }
  const nextSequence = base.projectionSequence + 1;
  const pendingPresentationDeletionRevisionByIdentity = {
    ...base.pendingPresentationDeletionRevisionByIdentity,
  };
  delete pendingPresentationDeletionRevisionByIdentity[key];
  return {
    ...base,
    terminalsByIdentity: { ...base.terminalsByIdentity, [key]: terminal },
    projectionSequence: nextSequence,
    pendingPresentationDeletionRevisionByIdentity,
    lastStreamSequenceByIdentity: {
      ...base.lastStreamSequenceByIdentity,
      [key]: nextSequence,
    },
  };
}

/**
 * Adopts a canonical unary projection under the collection ordering rule:
 * higher durable revisions win; at equal revision, a stream projection
 * accepted after request start wins; and a later replacement's absence wins.
 */
export function adoptPlainTerminalUnary(
  current: PlainTerminalCollection | undefined,
  terminal: PlainTerminalProjection,
  barrier: PlainTerminalProjectionBarrier,
): PlainTerminalCollection {
  const base = current ?? emptyPlainTerminalCollection();
  const key = identityKeyForProjection(terminal);
  const existing = base.terminalsByIdentity[key];
  if (existing === undefined && base.snapshotEpoch > barrier.snapshotEpoch) {
    return base;
  }
  const deletedRevision = base.deletedRevisionByIdentity[key];
  if (
    deletedRevision !== undefined &&
    deletedRevision >= terminal.record.revision
  ) {
    return base;
  }
  if (
    existing !== undefined &&
    existing.record.revision > terminal.record.revision
  ) {
    return base;
  }
  const streamAdvanced =
    (base.lastStreamSequenceByIdentity[key] ?? -1) > barrier.projectionSequence;
  if (
    streamAdvanced &&
    existing !== undefined &&
    existing.record.revision >= terminal.record.revision
  ) {
    return base;
  }
  const pendingPresentationDeletionRevisionByIdentity = {
    ...base.pendingPresentationDeletionRevisionByIdentity,
  };
  delete pendingPresentationDeletionRevisionByIdentity[key];
  return {
    ...base,
    terminalsByIdentity: { ...base.terminalsByIdentity, [key]: terminal },
    projectionSequence: base.projectionSequence + 1,
    pendingPresentationDeletionRevisionByIdentity,
  };
}

export function deletePlainTerminal(
  current: PlainTerminalCollection | undefined,
  identity: PlainTerminalFleetIdentity,
  revision: number,
): PlainTerminalCollection {
  const base = current ?? emptyPlainTerminalCollection();
  const key = identityKeyFor(identity);
  const previousDeletedRevision = base.deletedRevisionByIdentity[key] ?? -1;
  const existing = base.terminalsByIdentity[key];
  if (
    revision <= previousDeletedRevision ||
    (existing !== undefined && existing.record.revision > revision)
  ) {
    return base;
  }
  const terminalsByIdentity = { ...base.terminalsByIdentity };
  delete terminalsByIdentity[key];
  const nextSequence = base.projectionSequence + 1;
  return {
    ...base,
    terminalsByIdentity,
    projectionSequence: nextSequence,
    lastStreamSequenceByIdentity: {
      ...base.lastStreamSequenceByIdentity,
      [key]: nextSequence,
    },
    deletedRevisionByIdentity: {
      ...base.deletedRevisionByIdentity,
      [key]: revision,
    },
  };
}

/** Unary deletion counterpart to `adoptPlainTerminalUnary`. */
export function adoptPlainTerminalDeletionUnary(
  current: PlainTerminalCollection | undefined,
  identity: PlainTerminalFleetIdentity,
  revision: number,
  barrier: PlainTerminalProjectionBarrier,
): PlainTerminalCollection {
  const base = current ?? emptyPlainTerminalCollection();
  const key = identityKeyFor(identity);
  const existing = base.terminalsByIdentity[key];
  const streamAdvanced =
    (base.lastStreamSequenceByIdentity[key] ?? -1) > barrier.projectionSequence;
  if (
    streamAdvanced &&
    existing !== undefined &&
    existing.record.revision >= revision
  ) {
    return base;
  }
  const previousDeletedRevision = base.deletedRevisionByIdentity[key] ?? -1;
  if (
    revision <= previousDeletedRevision ||
    (existing !== undefined && existing.record.revision > revision)
  ) {
    return base;
  }
  const terminalsByIdentity = { ...base.terminalsByIdentity };
  delete terminalsByIdentity[key];
  return {
    ...base,
    terminalsByIdentity,
    projectionSequence: base.projectionSequence + 1,
    deletedRevisionByIdentity: {
      ...base.deletedRevisionByIdentity,
      [key]: revision,
    },
  };
}

export function setPlainTerminalStreamStatus(
  current: PlainTerminalCollection | undefined,
  status: StreamConnectionStatus,
): PlainTerminalCollection {
  const base = current ?? emptyPlainTerminalCollection();
  return {
    ...base,
    streamStatus: status,
    // Only an open connection carries snapshot freshness forward. Any other
    // status - including one added later - must invalidate it.
    streamSnapshotFresh: status === "open" ? base.streamSnapshotFresh : false,
  };
}

export function plainTerminalCollectionValues(
  collection: PlainTerminalCollection | undefined,
): readonly PlainTerminalProjection[] {
  return Object.values(collection?.terminalsByIdentity ?? {})
    .filter(
      (terminal): terminal is PlainTerminalProjection => terminal !== undefined,
    )
    .toSorted((left, right) => {
      const created = left.record.createdAt.localeCompare(
        right.record.createdAt,
      );
      if (created !== 0) return created;
      const host = left.record.hostId.localeCompare(right.record.hostId);
      return host !== 0
        ? host
        : left.record.terminalId.localeCompare(right.record.terminalId);
    });
}

export function plainTerminalActionAuthorized(
  collection: PlainTerminalCollection | undefined,
  hostId: string,
  terminalId: string,
): boolean {
  return getPlainTerminal(collection, hostId, terminalId) !== undefined;
}

export function plainTerminalAuthorityCanMutate(
  capability: PlainTerminalCapability,
  collection: PlainTerminalCollection | undefined,
): boolean {
  return (
    capability.status === "capable" &&
    collection?.streamStatus === "open" &&
    collection.streamCompatibility === "compatible" &&
    collection.streamSnapshotFresh
  );
}

export interface PlainTerminalViewModel {
  readonly terminalId: string;
  readonly manualTitle: string | null;
  readonly activeProcessName: string | null;
  readonly launchCwd: string;
  readonly liveCwd: string | null;
  readonly runtimeStatus: "running" | "dormant" | "unknown";
  readonly isDormant: boolean;
  readonly isRuntimeUnknown: boolean;
  readonly displayTitle: string;
}

/** Keeps semantic title/process/cwd/runtime fields separate for every surface. */
export function selectPlainTerminalViewModel(
  terminal: PlainTerminalProjection,
): PlainTerminalViewModel {
  const liveCwd =
    terminal.runtime.status === "running" ? terminal.runtime.currentCwd : null;
  const activeProcessName =
    terminal.runtime.status === "running"
      ? terminal.runtime.activeProcessName
      : null;
  return {
    terminalId: terminal.record.terminalId,
    manualTitle: terminal.record.manualTitle,
    activeProcessName,
    launchCwd: terminal.record.launch.cwd,
    liveCwd,
    runtimeStatus: terminal.runtime.status,
    isDormant: terminal.runtime.status === "dormant",
    isRuntimeUnknown: terminal.runtime.status === "unknown",
    displayTitle: terminalSessionTitle({
      title: terminal.record.manualTitle,
      activeProcessName,
      currentCwd: liveCwd ?? terminal.record.launch.cwd,
    }),
  };
}

export interface LegacyPlainTerminalMigrationAdapter {
  /** Legacy semantic evidence; returning null means there is nothing to import. */
  readonly read: () => ImportLegacyPlainTerminalRequest | null;
  /** Called only after the capable host has acknowledged the canonical winner. */
  readonly adoptCanonical: (
    response: Extract<
      ImportLegacyPlainTerminalResponse,
      { readonly status: "imported" | "existing" }
    >,
  ) => void | Promise<void>;
}

export type PlainTerminalMigrationOutcome =
  | { readonly status: "preserved"; readonly reason: "legacy-host" | "stale" }
  | { readonly status: "nothing-to-import" }
  | {
      readonly status: "adopted";
      readonly response: ImportLegacyPlainTerminalResponse;
    };

export interface PlainTerminalMigrationAuthority {
  readonly hostId: string;
  readonly scope: PlainTerminalScope;
  /**
   * Only the status gates a migration, so callers may pass the bare status
   * and key their effects on that primitive: an effect keyed on the
   * capability OBJECT re-fired on every re-render (the authority hook
   * rebuilds it each render), and after a failed import each re-fire was
   * another import, another failure, another toast - a storm at RPC speed.
   */
  readonly capability: Pick<PlainTerminalCapability, "status">;
  readonly canMutate: boolean;
  readonly importLegacy: (
    request: ImportLegacyPlainTerminalRequest,
  ) => Promise<ImportLegacyPlainTerminalResponse>;
}

/**
 * Coordinates one first-host-import-wins attempt and never rewrites legacy
 * evidence before a capable, fresh host returns its canonical answer.
 */
export class PlainTerminalMigrationCoordinator {
  private readonly inFlight = new Map<
    string,
    Promise<ImportLegacyPlainTerminalResponse>
  >();

  migrate(
    authority: PlainTerminalMigrationAuthority,
    adapter: LegacyPlainTerminalMigrationAdapter,
  ): Promise<PlainTerminalMigrationOutcome> {
    if (authority.capability.status !== "capable") {
      return Promise.resolve({ status: "preserved", reason: "legacy-host" });
    }
    if (!authority.canMutate) {
      return Promise.resolve({ status: "preserved", reason: "stale" });
    }
    const evidence = adapter.read();
    if (evidence === null) {
      return Promise.resolve({ status: "nothing-to-import" });
    }
    const key = migrationKey(
      authority.hostId,
      authority.scope,
      evidence.terminalId,
    );
    let sharedHostResult = this.inFlight.get(key);
    if (sharedHostResult === undefined) {
      const importAttempt = authority.importLegacy(evidence);
      const trackedAttempt = importAttempt.finally(() => {
        if (this.inFlight.get(key) === trackedAttempt) {
          this.inFlight.delete(key);
        }
      });
      this.inFlight.set(key, trackedAttempt);
      sharedHostResult = trackedAttempt;
    }

    // Only the host operation is deduplicated. Every surface adopts a
    // canonical winner; deleted results are committed exclusively by the
    // shared QueryClient deletion boundary inside the mutation.
    return sharedHostResult.then(
      async (response): Promise<PlainTerminalMigrationOutcome> => {
        if (response.status !== "deleted") {
          await adapter.adoptCanonical(response);
        }
        return { status: "adopted", response };
      },
    );
  }
}

export function plainTerminalScopeKey(scope: PlainTerminalScope): string {
  return scope.kind === "independent" ? "independent" : `epic:${scope.epicId}`;
}

/**
 * Injective `(hostId, scope.kind, epicId|"")` key for shared stream ownership.
 * Scope is a separate tuple member so epic ids cannot collide with the
 * independent sentinel or with host-id delimiters.
 */
export function plainTerminalHostScopeIdentityKey(
  hostId: string,
  scope: PlainTerminalScope,
): string {
  return JSON.stringify([
    hostId,
    scope.kind,
    scope.kind === "epic" ? scope.epicId : "",
  ]);
}

/**
 * Injective `(hostId, scope.kind, epicId|"", terminalId)` key for migration
 * in-flight dedup. Same tuple encoding as fleet identity: quotes, NULs, and
 * backslashes stay distinct.
 */
export function plainTerminalMigrationIdentityKey(
  hostId: string,
  scope: PlainTerminalScope,
  terminalId: string,
): string {
  return JSON.stringify([
    hostId,
    scope.kind,
    scope.kind === "epic" ? scope.epicId : "",
    terminalId,
  ]);
}

function migrationKey(
  hostId: string,
  scope: PlainTerminalScope,
  terminalId: string,
): string {
  return plainTerminalMigrationIdentityKey(hostId, scope, terminalId);
}
