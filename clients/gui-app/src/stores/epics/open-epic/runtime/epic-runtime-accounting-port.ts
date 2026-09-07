/** The runtime's own accounting contract - 4e's inversion. */
import type {
  EvictionOutcome,
  RuntimeEnvironment,
} from "@traycer-clients/shared/replica-runtime";
import type { EpicReplicaProjectionCounts } from "@/stores/replica-memory/epic-replica-budget";

/** What the accounting books need to ask the runtime, in the runtime's terms. */
/** An {@link EvictionOutcome} that can also say "accepted, not yet performed". */
export interface HotDocEvictionOutcome extends EvictionOutcome {
  /** Bytes whose demotion was ACCEPTED and dispatched, but whose freeing has not happened yet. */
  readonly deferredBytes: number;
}

export interface EpicRuntimeAccountingSource {
  /** Rooms currently resident as live `Y.Doc`s. */
  materializedRoomIds(): readonly string[];
  /**
   * The `protectedBytesByKind` half is not decoration: it is the only explanation the accountant
   * ever receives for why a plane is still over its limit, and it is what distinguishes "everything
   */
  demoteColdestUnpinned(overBytes: number): HotDocEvictionOutcome;
  /** The root replica's settled wire bytes. */
  measureRootBytes(): number;
  /** Projection row counts, for the memory telemetry surface. */
  projectionCounts(): EpicReplicaProjectionCounts;
}

/** Where the runtime reports its bytes. */
export interface EpicRuntimeAccountingPort {
  /**
   * Register the runtime's books and start answering {@link EpicRuntimeAccountingSource} queries.
   * Called once, after the runtime's own state is constructed.
   */
  registerBooks(source: EpicRuntimeAccountingSource): void;
  /** Deregister and release every holder this runtime owns. */
  unregisterBooks(): void;

  settleRootBytes(bytes: number): void;
  settleColdRoomBytes(artifactRoomId: string, bytes: number): void;
  settleCommandOverlayBytes(bytes: number): void;
  settleHotDocBytes(artifactRoomId: string, bytes: number): void;
  chargeHotDocProvisional(artifactRoomId: string, bytes: number): void;
  releaseHotDoc(artifactRoomId: string): void;

  /**
   * This tier is about to DISPATCH an eviction rather than perform one, so the zero it is about to
   * return means "later", not "refused".
   */
  noteHotDocEvictionDeferred(): void;
}

/** What an implementation needs to name this runtime's holders. */
export interface EpicRuntimeAccountingIdentity {
  readonly hostId: string;
  readonly epicId: string;
  readonly environment: RuntimeEnvironment;
}
