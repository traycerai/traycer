/**
 * The runtime's own accounting contract — 4e's inversion.
 *
 * Before this, `epic-replica-runtime.ts` reached
 * `ensureProcessMemoryRuntime(environment)` directly: a module-scoped
 * `let processRuntime` whose app-wideness is guaranteed by MODULE IDENTITY. A
 * worker importing that module gets a second COPY of the accountant rather than
 * a second reference to one, and nothing in-process can observe the difference
 * because in-process there is only ever one copy.
 *
 * **This is not a mirror of T5.** A mirror restates someone else's contract and
 * rots against it. These members are named for what the RUNTIME does — settle
 * the root, settle a cold room, settle the command overlay, settle/charge/
 * release a hot doc — and T5's books are one implementation of them, living on
 * main. That is why the identity vocabulary is absent here: `bookKey`,
 * `runtimeToken` and the four holder-id families are how the ACCOUNTANT names
 * holders, so they belong to the implementation, not to the caller.
 *
 * A consequence worth stating, because it is stronger than the constraint it
 * satisfies: the runtime token never crosses the worker boundary at all. It was
 * to be a bootstrap input; with holder-id composition main-side there is
 * nothing to pass, so the one process-wide minter keeps its monopoly by
 * construction rather than by discipline.
 */
import type {
  EvictionOutcome,
  RuntimeEnvironment,
} from "@traycer-clients/shared/replica-runtime";
import type { EpicReplicaProjectionCounts } from "@/stores/replica-memory/epic-replica-budget";

/**
 * What the accounting books need to ask the runtime, in the runtime's terms.
 *
 * **This is the direction that makes 4e hard.** The outbound members below are
 * all `void` and push cleanly across a thread; these four are called
 * SYNCHRONOUSLY by the accountant during a reconcile, and after the flip the
 * accountant is on main while the tier is in the worker — so a synchronous
 * main→worker call is exactly what cannot exist.
 *
 * Three of the four are pure reads and are answerable from a main-side cache
 * the worker refreshes on every settle push. {@link demoteColdestUnpinned} is
 * not: it performs the eviction, and its return decrements a running total.
 * At the flip it becomes a request — the proxy answers `reclaimedBytes: 0`,
 * dispatches, and the worker's settles reconcile on arrival.
 */
export interface EpicRuntimeAccountingSource {
  /** Rooms currently resident as live `Y.Doc`s. */
  materializedRoomIds(): readonly string[];
  /**
   * Evict cold-first until `overBytes` is recovered, and report what was
   * freed and what refused to be.
   *
   * The `protectedBytesByKind` half is not decoration: it is the only
   * explanation the accountant ever receives for why a plane is still over its
   * limit, and it is what distinguishes "everything here is pinned" from
   * "there was nothing to free".
   */
  demoteColdestUnpinned(overBytes: number): EvictionOutcome;
  /** The root replica's settled wire bytes. */
  measureRootBytes(): number;
  /** Projection row counts, for the memory telemetry surface. */
  projectionCounts(): EpicReplicaProjectionCounts;
}

/**
 * Where the runtime reports its bytes.
 *
 * Every member is `void` and none may answer a question, so the whole surface
 * survives becoming a fire-and-forget push across a worker boundary without
 * changing shape. That property is the point of the interface; adding a member
 * that returns anything but `void` un-does it.
 *
 * Reconciliation is deliberately NOT a member. The runtime says what settled;
 * WHEN a plane is reconciled is the book's decision, and today's split
 * (reconcile after a root, cold-room or hot-doc settle; not after a
 * provisional charge, a release, or a command-overlay settle) is preserved
 * inside the implementation where it can be read in one place.
 */
export interface EpicRuntimeAccountingPort {
  /**
   * Register the runtime's books and start answering
   * {@link EpicRuntimeAccountingSource} queries. Called once, after the
   * runtime's own state is constructed.
   */
  registerBooks(source: EpicRuntimeAccountingSource): void;
  /**
   * Deregister and release every holder this runtime owns.
   *
   * One member rather than three (`detach` hot, `detach` replicas, `release`
   * the book) because a caller that can do two of the three is a leak with a
   * seam to leak through.
   */
  unregisterBooks(): void;

  settleRootBytes(bytes: number): void;
  settleColdRoomBytes(artifactRoomId: string, bytes: number): void;
  settleCommandOverlayBytes(bytes: number): void;
  settleHotDocBytes(artifactRoomId: string, bytes: number): void;
  chargeHotDocProvisional(artifactRoomId: string, bytes: number): void;
  releaseHotDoc(artifactRoomId: string): void;
}

/** What an implementation needs to name this runtime's holders. */
export interface EpicRuntimeAccountingIdentity {
  readonly hostId: string;
  readonly epicId: string;
  readonly environment: RuntimeEnvironment;
}
