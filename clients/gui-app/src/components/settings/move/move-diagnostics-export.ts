import type {
  EnvironmentStatusResponseV11,
  SetupAttempt,
} from "@traycer/protocol/host/environment-schemas";
import { moveItemCounts } from "@/components/settings/panels/host-overview-settings-card-model";
import { moveStoppedReason } from "@/lib/environment/move-in-progress";

/** The settings Details export's own name, `traycer-settings-diagnostics.json`, for the move. */
export const MOVE_DIAGNOSTICS_FILE_NAME = "traycer-move-diagnostics.json";

interface MoveDiagnosticsAttempt {
  readonly attemptId: string;
  readonly trigger: SetupAttempt["trigger"];
  readonly itemRevision: number;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly exitStatus: number | null;
  readonly stageReached: string | null;
  readonly result: SetupAttempt["result"];
}

export interface MoveDiagnosticsExport {
  readonly version: 1;
  readonly exportedAt: number;
  readonly setup: { readonly stage: string; readonly state: string } | null;
  readonly stopReason: string | null;
  readonly items: { readonly applied: number; readonly total: number };
  readonly pendingUploads: number;
  readonly attempts: readonly MoveDiagnosticsAttempt[] | null;
}

/**
 * A computer's move diagnostics where no environment answers for it: what its
 * own status and setup attempts already serve the app, field by field. Never
 * a value, an item's key, a script or its hash, or an identifier beyond the
 * attempt's own. `attempts` is null on a host without
 * `environment.setup.attempts`.
 */
export function moveDiagnosticsExport(
  status: EnvironmentStatusResponseV11,
  attempts: readonly SetupAttempt[] | null,
  exportedAt: number,
): MoveDiagnosticsExport {
  const setup = status.setup;
  const { applied, total } = moveItemCounts(status);
  return {
    version: 1,
    exportedAt,
    setup: setup === null ? null : { stage: setup.stage, state: setup.state },
    stopReason: setup === null ? null : moveStoppedReason(setup.state),
    items: { applied, total },
    pendingUploads: status.pendingUploads.length,
    attempts:
      attempts === null
        ? null
        : attempts.map((attempt) => ({
            attemptId: attempt.attemptId,
            trigger: attempt.trigger,
            itemRevision: attempt.itemRevision,
            startedAt: attempt.startedAt,
            endedAt: attempt.endedAt,
            exitStatus: attempt.exitStatus,
            stageReached: attempt.stageReached,
            result: attempt.result,
          })),
  };
}
