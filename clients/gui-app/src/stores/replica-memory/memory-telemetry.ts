import type {
  AccountantSnapshot,
  BudgetPlaneId,
  BudgetPressure,
} from "@traycer-clients/shared/replica-runtime";
import { BUDGET_PLANE_IDS } from "@traycer-clients/shared/replica-runtime";
import type { EpicReplicaProjectionCounts } from "@/stores/replica-memory/epic-replica-budget";
import type { ProcessMemoryRuntime } from "@/stores/replica-memory/process-memory-accountant";

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
  readonly projectionRowCounts: EpicReplicaProjectionCounts;
  readonly evictionEffectiveness: {
    readonly evictionsRequested: number;
    readonly bytesReclaimed: number;
    readonly evictionsRefused: number;
  };
  readonly pressureByPlane: Readonly<Record<BudgetPlaneId, BudgetPressure>>;
  readonly observedCeilingBytes: number;
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
  for (const plane of accountant.planes) {
    pressureByPlane[plane.planeId] = plane.pressure;
    evictionsRequested += plane.evictionsRequested;
    bytesReclaimed += plane.bytesReclaimed;
    evictionsRefused += plane.evictionsRefused;
  }
  return {
    accountant,
    docsResident: runtime.hotDocs.docsResident(),
    bytesDecoded: accountant.totalChargedBytes,
    projectionRowCounts: runtime.epicReplicas.projectionRowCounts(),
    evictionEffectiveness: {
      evictionsRequested,
      bytesReclaimed,
      evictionsRefused,
    },
    pressureByPlane,
    observedCeilingBytes: runtime.observedCeilingBytes,
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
