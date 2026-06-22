import type {
  DesktopOwnershipClaimResult,
  DesktopWindowsBridge,
} from "@/lib/windows/types";

let desktopWindowsBridge: DesktopWindowsBridge | null = null;

export function setDesktopEpicOwnershipBridge(
  bridge: DesktopWindowsBridge | null,
): void {
  desktopWindowsBridge = bridge;
}

export function getDesktopEpicOwnershipBridge(): DesktopWindowsBridge | null {
  return desktopWindowsBridge;
}

export async function claimDesktopEpicOwnership(
  tabId: string,
  epicId: string,
): Promise<DesktopOwnershipClaimResult> {
  if (desktopWindowsBridge === null) return { ok: true };
  return desktopWindowsBridge.ownership.claim(tabId, epicId);
}

export async function releaseDesktopEpicOwnership(
  tabId: string,
): Promise<void> {
  if (desktopWindowsBridge === null) return;
  await desktopWindowsBridge.ownership.release(tabId);
}

export async function releaseDesktopEpicOwnershipForEpic(
  epicId: string,
): Promise<void> {
  if (desktopWindowsBridge === null) return;
  const bridge = desktopWindowsBridge;
  const entries = await bridge.ownership.snapshot();
  await Promise.all(
    entries.flatMap((entry) =>
      entry.epicId === epicId ? [bridge.ownership.release(entry.tabId)] : [],
    ),
  );
}
