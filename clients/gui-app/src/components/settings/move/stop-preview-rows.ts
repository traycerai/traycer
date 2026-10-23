import type { EnvironmentMoveStopPreviewResponse } from "@traycer/protocol/host/environment/move-contracts";
import type {
  StopManagedRow,
  StopNeedsChoiceRow,
} from "@/components/settings/move/stop-sharing-choices";

export function stopManagedFromPreview(
  preview: EnvironmentMoveStopPreviewResponse,
): readonly StopManagedRow[] {
  return preview.managed.map((row) => ({
    key: row.key,
    label: row.label,
    detail: row.detail,
  }));
}

export function stopNeedsChoiceFromPreview(
  preview: EnvironmentMoveStopPreviewResponse,
): readonly StopNeedsChoiceRow[] {
  return preview.needsChoice.map((entry) => ({
    key: entry.row.key,
    label: entry.row.label,
    detail: entry.row.detail,
    reason: entry.reason,
  }));
}
