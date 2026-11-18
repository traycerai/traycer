import type { DesktopWindowsBridge } from "@/lib/windows/types";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

export interface OpenEpicInNewWindowInput {
  readonly epicId: string;
  /**
   * Tab id segment for the new window's epic route. The epic is not open in
   * this window (the open-here case is handled upstream by the move flow), so
   * this is the `epicId` fallback; the destination window self-heals it into a
   * real tab id on mount.
   */
  readonly tabId: string;
  /** Phase rows carry `migrationSource=phase` so the migration view opens. */
  readonly isPhase: boolean;
}

/**
 * Opens a history epic/phase that is NOT open in the current window in a
 * separate desktop window.
 *
 * The "already open in this window" case is handled by the caller through
 * `useHistoryOpenInNewWindowFlow` -> `useEpicOpenInNewWindowFlow`, which pops
 * the live tab out via the ownership-aware move flow (with its unsynced-edits
 * confirm dialog). This helper only covers the remaining cases:
 *
 *  1. `ownership.snapshot()` catches the epic when it's the live/mounted tab in
 *     ANOTHER window; we focus that window. The current window is excluded from
 *     the scan: phases resolve in-place under `epicId === phaseId` and so the
 *     current window can hold an ownership entry for `input.epicId` (phase rows
 *     always route here, never through the move flow). Matching it would refocus
 *     this window instead of opening a new one - the silent self-focus bug.
 *  2. Otherwise open a fresh window at the epic route. Resolving here (rather
 *     than letting the new window's claim-on-mount bounce back to `/epics`)
 *     keeps the focus path flash-free.
 *
 * Known gap: an epic open in ANOTHER window only as an unmounted/background tab
 * holds no ownership entry, so step 1 misses it. Closing that fully needs the
 * desktop main process to resolve the epic across every window's per-window
 * snapshot; the renderer cannot see other windows' tab lists.
 */
export async function openEpicInNewWindow(
  bridge: DesktopWindowsBridge,
  input: OpenEpicInNewWindowInput,
): Promise<void> {
  Analytics.getInstance().track(AnalyticsEvent.TaskOpened, {
    source: "history",
  });
  const owned = await bridge.ownership.snapshot();
  const existing = owned.find(
    (entry) =>
      entry.epicId === input.epicId && entry.windowId !== bridge.windowId,
  );
  if (existing !== undefined) {
    await bridge.requestFocus(existing.windowId);
    return;
  }
  await bridge.requestNew(buildEpicRoute(input));
}

function buildEpicRoute(input: OpenEpicInNewWindowInput): string {
  const base = `/epics/${encodeURIComponent(input.epicId)}/${encodeURIComponent(input.tabId)}`;
  return input.isPhase ? `${base}?migrationSource=phase` : base;
}
