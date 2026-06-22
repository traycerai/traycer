import { EventEmitter } from "node:events";
import type {
  PerWindowLandingDraft,
  PerWindowSnapshot,
  PerWindowStatePatch,
} from "../../ipc-contracts/window-types";
import type { DesktopStateStore } from "./desktop-state-store";

export interface PerWindowStateChange {
  readonly windowId: string;
  readonly snapshot: PerWindowSnapshot;
}

type PerWindowStateListener = (change: PerWindowStateChange) => void;

export function createEmptyPerWindowSnapshot(): PerWindowSnapshot {
  return {
    epicTabs: [],
    activeTabId: null,
    canvasByTabId: {},
    landingDrafts: [],
    activeLandingDraftId: null,
  };
}

export class PerWindowState {
  private readonly events = new EventEmitter();
  private readonly store: DesktopStateStore | null;
  private readonly snapshots = new Map<string, PerWindowSnapshot>();

  constructor(store: DesktopStateStore | null) {
    this.store = store;
    if (store !== null) {
      for (const [windowId, snapshot] of Object.entries(
        store.getWindowSnapshots(),
      )) {
        this.snapshots.set(windowId, snapshot);
      }
    }
  }

  get(windowId: string): PerWindowSnapshot {
    return this.snapshots.get(windowId) ?? createEmptyPerWindowSnapshot();
  }

  update(windowId: string, patch: PerWindowStatePatch): void {
    const current = this.get(windowId);
    const landingDrafts =
      "landingDrafts" in patch
        ? uniqueLandingDrafts(patch.landingDrafts ?? [])
        : uniqueLandingDrafts(current.landingDrafts);
    const activeLandingDraftId =
      "activeLandingDraftId" in patch
        ? (patch.activeLandingDraftId ?? null)
        : current.activeLandingDraftId;
    const next: PerWindowSnapshot = {
      epicTabs:
        "epicTabs" in patch
          ? uniquePerWindowTabs(patch.epicTabs ?? [])
          : uniquePerWindowTabs(current.epicTabs),
      activeTabId:
        "activeTabId" in patch
          ? (patch.activeTabId ?? null)
          : current.activeTabId,
      canvasByTabId:
        "canvasByTabId" in patch
          ? mergeJsonRecord(current.canvasByTabId, patch.canvasByTabId ?? {})
          : current.canvasByTabId,
      landingDrafts,
      activeLandingDraftId,
    };
    this.snapshots.set(windowId, next);
    this.store?.setWindowSnapshot(windowId, next);
    this.events.emit("change", { windowId, snapshot: next });
  }

  clear(windowId: string): void {
    this.snapshots.delete(windowId);
    this.store?.deleteWindowSnapshot(windowId);
    this.events.emit("change", {
      windowId,
      snapshot: createEmptyPerWindowSnapshot(),
    });
  }

  on(event: "change", listener: PerWindowStateListener): void {
    this.events.on(event, listener);
  }

  off(event: "change", listener: PerWindowStateListener): void {
    this.events.off(event, listener);
  }
}

function uniquePerWindowTabs(
  tabs: PerWindowSnapshot["epicTabs"],
): PerWindowSnapshot["epicTabs"] {
  const seen = new Set<string>();
  return tabs.flatMap((tab) => {
    if (seen.has(tab.id)) return [];
    seen.add(tab.id);
    return [tab];
  });
}

function uniqueLandingDrafts(
  drafts: readonly PerWindowLandingDraft[],
): readonly PerWindowLandingDraft[] {
  const seen = new Set<string>();
  return drafts.flatMap((draft) => {
    if (seen.has(draft.id)) return [];
    seen.add(draft.id);
    return [draft];
  });
}

function mergeJsonRecord(
  current: PerWindowSnapshot["canvasByTabId"],
  patch: PerWindowStatePatch["canvasByTabId"],
): PerWindowSnapshot["canvasByTabId"] {
  const next: Record<string, PerWindowSnapshot["canvasByTabId"][string]> = {
    ...current,
  };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === null) {
      delete next[key];
      continue;
    }
    next[key] = value;
  }
  return next;
}
