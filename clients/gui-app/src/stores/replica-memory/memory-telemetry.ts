import type {
  AccountantSnapshot,
  BudgetPlaneId,
  BudgetPressure,
} from "@traycer-clients/shared/replica-runtime";
import { BUDGET_PLANE_IDS } from "@traycer-clients/shared/replica-runtime";
import type { EpicReplicaProjectionCounts } from "@/stores/replica-memory/epic-replica-budget";
import type { ProcessMemoryRuntime } from "@/stores/replica-memory/process-memory-accountant";
import { getRetentionProfile } from "@/stores/replica-memory/retention-profile";

/**
 * Exit-criteria telemetry for putting a plane under the accountant: docs
 * resident, bytes decoded, projection row counts, eviction effectiveness,
 * per-plane budget pressure.
 *
 * This is an INPUT the sync pill (or a memory-pressure affordance) may read.
 * It does not say how to render — T2 left pill presentation UI-owned.
 */
export interface ReplicaMemoryTelemetry {
  readonly accountant: AccountantSnapshot;
  readonly docsResident: number;
  readonly bytesDecoded: number;
  /** UTF-8 JSON form and calibrated heap estimate are distinct measurements. */
  readonly rawReplicaDataBytes: number;
  readonly estimatedReplicaDataHeapBytes: number;
  readonly rawMainProjectionBytes: number;
  readonly estimatedMainProjectionHeapBytes: number;
  readonly rawChatOwnedStateBytes: number;
  readonly estimatedChatOwnedStateHeapBytes: number;
  readonly projectionRowCounts: EpicReplicaProjectionCounts;
  readonly evictionEffectiveness: {
    readonly evictionsRequested: number;
    readonly bytesReclaimed: number;
    readonly evictionsRefused: number;
    /**
     * Requests a tier DISPATCHED rather than declined. Mutually exclusive with
     * `evictionsRefused` by construction, so reading one without the other
     * turns "freeing is in flight" into "freeing was refused".
     */
    readonly evictionsDeferred: number;
  };
  readonly pressureByPlane: Readonly<Record<BudgetPlaneId, BudgetPressure>>;
  readonly observedCeilingBytes: number;
  readonly maxManagedDataBytes: number;
}

/**
 * The only budget fact the sync pill is invited to weigh: per-plane pressure
 * plus the observational ceiling. Presentation is UI-owned.
 */
export interface ReplicaMemoryPillInput {
  readonly pressureByPlane: Readonly<Record<BudgetPlaneId, BudgetPressure>>;
  readonly totalChargedBytes: number;
  readonly observedCeilingBytes: number;
}

export function collectReplicaMemoryTelemetry(
  runtime: ProcessMemoryRuntime,
): ReplicaMemoryTelemetry {
  const accountant = runtime.accountant.snapshot();
  const pressureByPlane: Record<BudgetPlaneId, BudgetPressure> = {};
  let evictionsRequested = 0;
  let bytesReclaimed = 0;
  let evictionsRefused = 0;
  let evictionsDeferred = 0;
  for (const plane of accountant.planes) {
    pressureByPlane[plane.planeId] = plane.pressure;
    evictionsRequested += plane.evictionsRequested;
    bytesReclaimed += plane.bytesReclaimed;
    evictionsRefused += plane.evictionsRefused;
    evictionsDeferred += plane.evictionsDeferred;
  }
  return {
    accountant,
    docsResident: runtime.hotDocs.docsResident(),
    bytesDecoded: accountant.totalChargedBytes,
    rawReplicaDataBytes: runtime.epicReplicas.rawReplicaDataBytes(),
    estimatedReplicaDataHeapBytes:
      runtime.epicReplicas.estimatedReplicaDataHeapBytes(),
    rawMainProjectionBytes: runtime.epicReplicas.rawMainProjectionBytes(),
    estimatedMainProjectionHeapBytes:
      runtime.epicReplicas.estimatedMainProjectionHeapBytes(),
    rawChatOwnedStateBytes: runtime.chatWindows.rawOwnedStateBytes(),
    estimatedChatOwnedStateHeapBytes:
      runtime.chatWindows.estimatedOwnedStateHeapBytes(),
    projectionRowCounts: runtime.epicReplicas.projectionRowCounts(),
    evictionEffectiveness: {
      evictionsRequested,
      bytesReclaimed,
      evictionsRefused,
      evictionsDeferred,
    },
    pressureByPlane,
    observedCeilingBytes: runtime.observedCeilingBytes,
    maxManagedDataBytes: getRetentionProfile().maxManagedDataBytes,
  };
}

export function replicaMemoryPillInputOf(
  telemetry: ReplicaMemoryTelemetry,
): ReplicaMemoryPillInput {
  return {
    pressureByPlane: telemetry.pressureByPlane,
    totalChargedBytes: telemetry.accountant.totalChargedBytes,
    observedCeilingBytes: telemetry.observedCeilingBytes,
  };
}

export function pressureOfPlane(
  telemetry: ReplicaMemoryTelemetry,
  planeId: BudgetPlaneId,
): BudgetPressure {
  return telemetry.pressureByPlane[planeId] ?? "under";
}

export { BUDGET_PLANE_IDS };
