import type { SchemaVersion } from "@traycer/protocol/framework/index";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type {
  ImportLegacyPlainTerminalRequest,
  ImportLegacyPlainTerminalResponse,
  PlainTerminalProjection,
  PlainTerminalScope,
} from "@traycer/protocol/host/terminal/plain-schemas";
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

/**
 * Resolves the optional family as a unit. A partial family is legacy behavior,
 * never a license to mix local and host authority method by method.
 */
export function resolvePlainTerminalCapability(input: {
  readonly manifestKnown: boolean;
  readonly versionFor: (method: PlainTerminalRpcMethod) => SchemaVersion | null;
}): PlainTerminalCapability {
  if (!input.manifestKnown) return { status: "unknown" };
  for (const method of PLAIN_TERMINAL_RPC_METHODS) {
    const version = input.versionFor(method);
    if (version === null || version.major !== 1) {
      return { status: "legacy" };
    }
  }
  return { status: "capable", schemaVersion: { major: 1, minor: 0 } };
}

export interface PlainTerminalCollection {
  readonly terminalsById: Readonly<
    Partial<Record<string, PlainTerminalProjection>>
  >;
  readonly deletedRevisionById: Readonly<Partial<Record<string, number>>>;
  /** Accepted tombstones whose broad presentation sweep awaits settlement. */
  readonly pendingPresentationDeletionRevisionById: Readonly<
    Partial<Record<string, number>>
  >;
  /** Monotonic client-side order for accepted stream/unary projections. */
  readonly projectionSequence: number;
  /** Monotonic count of accepted fresh stream snapshots. */
  readonly snapshotEpoch: number;
  /** Last accepted stream projection sequence for each logical id. */
  readonly lastStreamSequenceById: Readonly<Partial<Record<string, number>>>;
  readonly streamStatus: StreamConnectionStatus | null;
  readonly streamCompatibility: "unknown" | "compatible" | "incompatible";
  /** True only after a snapshot in the current stream connection episode. */
  readonly streamSnapshotFresh: boolean;
}

export interface PlainTerminalProjectionBarrier {
  readonly projectionSequence: number;
  readonly snapshotEpoch: number;
}

export function emptyPlainTerminalCollection(): PlainTerminalCollection {
  return {
    terminalsById: {},
    deletedRevisionById: {},
    pendingPresentationDeletionRevisionById: {},
    projectionSequence: 0,
    snapshotEpoch: 0,
    lastStreamSequenceById: {},
    streamStatus: null,
    streamCompatibility: "unknown",
    streamSnapshotFresh: false,
  };
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

export function replacePlainTerminalSnapshot(
  current: PlainTerminalCollection | undefined,
  terminals: readonly PlainTerminalProjection[],
): PlainTerminalCollection {
  const base = current ?? emptyPlainTerminalCollection();
  const nextSequence = base.projectionSequence + 1;
  const terminalsById: Record<string, PlainTerminalProjection> = {};
  const lastStreamSequenceById = { ...base.lastStreamSequenceById };
  const pendingPresentationDeletionRevisionById = {
    ...base.pendingPresentationDeletionRevisionById,
  };
  for (const terminal of terminals) {
    const terminalId = terminal.record.terminalId;
    const deletedRevision = base.deletedRevisionById[terminalId];
    if (
      deletedRevision === undefined ||
      terminal.record.revision > deletedRevision
    ) {
      terminalsById[terminalId] = terminal;
      lastStreamSequenceById[terminalId] = nextSequence;
      delete pendingPresentationDeletionRevisionById[terminalId];
    }
  }
  return {
    ...base,
    terminalsById,
    pendingPresentationDeletionRevisionById,
    projectionSequence: nextSequence,
    snapshotEpoch: base.snapshotEpoch + 1,
    lastStreamSequenceById,
    streamCompatibility: "compatible",
    streamSnapshotFresh: false,
  };
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
 * Stream projections accepted after the request barrier survive the list;
 * a fresh snapshot after that barrier dominates the entire delayed response.
 * A response begun after the current snapshot preserves existing freshness.
 */
export function seedPlainTerminalList(
  current: PlainTerminalCollection | undefined,
  terminals: readonly PlainTerminalProjection[],
  barrier: PlainTerminalProjectionBarrier,
): PlainTerminalCollection {
  const base = current ?? emptyPlainTerminalCollection();
  if (base.snapshotEpoch > barrier.snapshotEpoch) return base;

  const responseById = new Map(
    terminals.map((terminal) => [terminal.record.terminalId, terminal]),
  );
  const terminalIds = new Set([
    ...Object.keys(base.terminalsById),
    ...responseById.keys(),
  ]);
  let seeded = base;
  for (const terminalId of terminalIds) {
    const responseTerminal = responseById.get(terminalId);
    const streamAdvanced =
      (base.lastStreamSequenceById[terminalId] ?? -1) >
      barrier.projectionSequence;
    if (responseTerminal !== undefined) {
      seeded = adoptPlainTerminalUnary(seeded, responseTerminal, barrier);
    } else if (!streamAdvanced) {
      const terminalsById = { ...seeded.terminalsById };
      delete terminalsById[terminalId];
      seeded = { ...seeded, terminalsById };
    }
  }
  return {
    ...seeded,
    streamCompatibility: base.streamCompatibility,
    streamSnapshotFresh: base.streamSnapshotFresh,
  };
}

/** Stream upserts are last-frame-wins at equal durable revision. */
export function upsertPlainTerminal(
  current: PlainTerminalCollection | undefined,
  terminal: PlainTerminalProjection,
): PlainTerminalCollection {
  const base = current ?? emptyPlainTerminalCollection();
  const terminalId = terminal.record.terminalId;
  const deletedRevision = base.deletedRevisionById[terminalId];
  if (
    deletedRevision !== undefined &&
    deletedRevision >= terminal.record.revision
  ) {
    return base;
  }
  const existing = base.terminalsById[terminalId];
  if (
    existing !== undefined &&
    existing.record.revision > terminal.record.revision
  ) {
    return base;
  }
  const nextSequence = base.projectionSequence + 1;
  const pendingPresentationDeletionRevisionById = {
    ...base.pendingPresentationDeletionRevisionById,
  };
  delete pendingPresentationDeletionRevisionById[terminalId];
  return {
    ...base,
    terminalsById: { ...base.terminalsById, [terminalId]: terminal },
    projectionSequence: nextSequence,
    pendingPresentationDeletionRevisionById,
    lastStreamSequenceById: {
      ...base.lastStreamSequenceById,
      [terminalId]: nextSequence,
    },
  };
}

/**
 * Adopts a canonical unary projection under the collection ordering rule:
 * higher durable revisions win; at equal revision, a stream projection
 * accepted after request start wins; and a later snapshot's absence wins.
 */
export function adoptPlainTerminalUnary(
  current: PlainTerminalCollection | undefined,
  terminal: PlainTerminalProjection,
  barrier: PlainTerminalProjectionBarrier,
): PlainTerminalCollection {
  const base = current ?? emptyPlainTerminalCollection();
  const terminalId = terminal.record.terminalId;
  const existing = base.terminalsById[terminalId];
  if (existing === undefined && base.snapshotEpoch > barrier.snapshotEpoch) {
    return base;
  }
  const deletedRevision = base.deletedRevisionById[terminalId];
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
    (base.lastStreamSequenceById[terminalId] ?? -1) >
    barrier.projectionSequence;
  if (
    streamAdvanced &&
    existing !== undefined &&
    existing.record.revision >= terminal.record.revision
  ) {
    return base;
  }
  const pendingPresentationDeletionRevisionById = {
    ...base.pendingPresentationDeletionRevisionById,
  };
  delete pendingPresentationDeletionRevisionById[terminalId];
  return {
    ...base,
    terminalsById: { ...base.terminalsById, [terminalId]: terminal },
    projectionSequence: base.projectionSequence + 1,
    pendingPresentationDeletionRevisionById,
  };
}

export function deletePlainTerminal(
  current: PlainTerminalCollection | undefined,
  terminalId: string,
  revision: number,
): PlainTerminalCollection {
  const base = current ?? emptyPlainTerminalCollection();
  const previousDeletedRevision = base.deletedRevisionById[terminalId] ?? -1;
  const existing = base.terminalsById[terminalId];
  if (
    revision <= previousDeletedRevision ||
    (existing !== undefined && existing.record.revision > revision)
  ) {
    return base;
  }
  const terminalsById = { ...base.terminalsById };
  delete terminalsById[terminalId];
  const nextSequence = base.projectionSequence + 1;
  return {
    ...base,
    terminalsById,
    projectionSequence: nextSequence,
    lastStreamSequenceById: {
      ...base.lastStreamSequenceById,
      [terminalId]: nextSequence,
    },
    deletedRevisionById: {
      ...base.deletedRevisionById,
      [terminalId]: revision,
    },
  };
}

/** Unary deletion counterpart to `adoptPlainTerminalUnary`. */
export function adoptPlainTerminalDeletionUnary(
  current: PlainTerminalCollection | undefined,
  terminalId: string,
  revision: number,
  barrier: PlainTerminalProjectionBarrier,
): PlainTerminalCollection {
  const base = current ?? emptyPlainTerminalCollection();
  const existing = base.terminalsById[terminalId];
  const streamAdvanced =
    (base.lastStreamSequenceById[terminalId] ?? -1) >
    barrier.projectionSequence;
  if (
    streamAdvanced &&
    existing !== undefined &&
    existing.record.revision >= revision
  ) {
    return base;
  }
  const previousDeletedRevision = base.deletedRevisionById[terminalId] ?? -1;
  if (
    revision <= previousDeletedRevision ||
    (existing !== undefined && existing.record.revision > revision)
  ) {
    return base;
  }
  const terminalsById = { ...base.terminalsById };
  delete terminalsById[terminalId];
  return {
    ...base,
    terminalsById,
    projectionSequence: base.projectionSequence + 1,
    deletedRevisionById: {
      ...base.deletedRevisionById,
      [terminalId]: revision,
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
  return Object.values(collection?.terminalsById ?? {})
    .filter(
      (terminal): terminal is PlainTerminalProjection => terminal !== undefined,
    )
    .toSorted((left, right) => {
      const created = left.record.createdAt.localeCompare(
        right.record.createdAt,
      );
      return created !== 0
        ? created
        : left.record.terminalId.localeCompare(right.record.terminalId);
    });
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
  readonly runtimeStatus: "running" | "dormant";
  readonly isDormant: boolean;
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
  readonly capability: PlainTerminalCapability;
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

function migrationKey(
  hostId: string,
  scope: PlainTerminalScope,
  terminalId: string,
): string {
  return `${hostId}\u0000${plainTerminalScopeKey(scope)}\u0000${terminalId}`;
}
