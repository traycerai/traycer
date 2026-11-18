import type { EnvironmentMoveStopPreviewResponseV11 } from "@traycer/protocol/host/environment/move-contracts";
import type {
  StopManagedRow,
  StopNeedsChoiceRow,
} from "@/components/settings/move/stop-sharing-choices";
import { moveRowLabel } from "@/components/settings/personal/personal-page-status";

export function stopManagedFromPreview(
  preview: EnvironmentMoveStopPreviewResponseV11,
): readonly StopManagedRow[] {
  return preview.managed.map((row) => ({
    kind: row.kind,
    key: row.key,
    label: moveRowLabel(row),
    detail: row.detail,
  }));
}

export function stopNeedsChoiceFromPreview(
  preview: EnvironmentMoveStopPreviewResponseV11,
): readonly StopNeedsChoiceRow[] {
  return preview.needsChoice.map((entry) => ({
    kind: entry.row.kind,
    key: entry.row.key,
    label: moveRowLabel(entry.row),
    detail: entry.row.detail,
    origin: entry.origin,
    usedBy: entry.usedBy.map(moveRowLabel),
  }));
}
