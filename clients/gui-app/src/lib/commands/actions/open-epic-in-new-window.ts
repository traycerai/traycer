import type { DesktopWindowsBridge } from "@/lib/windows/types";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

export interface OpenEpicInNewWindowInput {
  readonly epicId: string;
  /**
   * Tab id segment for the new window's epic route.
   * The epic is not open in this window (the open-here case is handled upstream by the move flow), so this is the `epicId` fallback; the destination window self-heals it into a real tab id on mount.
   */
  readonly tabId: string;
  /** Phase rows carry `migrationSource=phase` so the migration view opens. */
  readonly isPhase: boolean;
}

/** Opens a history epic/phase that is NOT open in the current window in a separate desktop window. */
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
