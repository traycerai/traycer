import type { EnvironmentStatusResponse } from "@traycer/protocol/host/environment-schemas";
import { stoppedSharingAt } from "@/components/settings/move/status-planes";
import {
  FAILURE_REASONS,
  itemLabel,
} from "@/components/settings/personal/personal-page-status";

/**
 * What a stop still owes on this computer. Once sharing has stopped, the
 * host's `status.items` are exactly the removals it has not finished: a
 * `pending` one is still being removed, a `failed` or `unsupported` one
 * could not be, and stays until a retry succeeds. A finished removal leaves
 * the list.
 */
export interface StopCleanup {
  readonly pendingLine: string | null;
  /** One line per removal that could not be made, by item (kind and key). */
  readonly failedLines: readonly {
    readonly id: string;
    readonly text: string;
  }[];
}

export function stopCleanup(
  status: EnvironmentStatusResponse,
): StopCleanup | null {
  if (stoppedSharingAt(status) === null) return null;
  const pending = status.items.filter((item) => item.status === "pending");
  const failedLines: { readonly id: string; readonly text: string }[] = [];
  for (const item of status.items) {
    const id = JSON.stringify([item.kind, item.key]);
    if (item.status === "unsupported") {
      failedLines.push({
        id,
        text: `${itemLabel(item)} couldn't be removed: not supported on this version.`,
      });
    } else if (item.status === "failed") {
      // Destructured: see `failedText` in `personal-page-status.ts`.
      const { code } = item;
      const reason = FAILURE_REASONS[code];
      failedLines.push({
        id,
        text:
          reason === undefined
            ? `${itemLabel(item)} couldn't be removed.`
            : `${itemLabel(item)} couldn't be removed: ${reason}.`,
      });
    }
  }
  if (pending.length === 0 && failedLines.length === 0) return null;
  return {
    pendingLine:
      pending.length === 0
        ? null
        : `${pending.length} ${pending.length === 1 ? "item" : "items"} still being removed from this computer.`,
    failedLines,
  };
}
