import { EventEmitter } from "node:events";
import type {
  FlushWindowDraftTopologyResult,
  LandingDraftReference,
  MoveWindowDraftReferenceRequest,
  MoveWindowDraftReferenceResult,
  PerWindowLandingDraft,
  PerWindowSnapshot,
  PerWindowStateCapabilities,
  PerWindowStatePatch,
  PerWindowStateUpdateAcknowledgement,
  UpdateWindowDraftReferencesRequest,
  WindowDraftTopologyResult,
} from "../../ipc-contracts/window-types";
import type { DesktopStateStore } from "./desktop-state-store";

export interface PerWindowStateChange {
  readonly windowId: string;
  readonly snapshot: PerWindowSnapshot;
  /**
   * How this change was produced. `"clear"` is a window-teardown wipe (the
   * durable snapshot was deleted); it is deliberately NOT forwarded to a renderer
   * (see the IPC forwarder), so a reloading / re-registering live window is never
   * clobbered with `createEmptyPerWindowSnapshot()`. `"update"` is an ordinary
   * state write and forwards normally. Topology changes bypass renderer
   * projection echo suppression.
   */
  readonly origin: "update" | "clear" | "draft-topology";
}

type PerWindowStateListener = (change: PerWindowStateChange) => void;

export function createEmptyPerWindowSnapshot(): PerWindowSnapshot {
  return {
    revision: 0,
    epicTabs: [],
    activeTabId: null,
    canvasByTabId: {},
    landingDrafts: [],
    activeLandingDraftId: null,
    tabStripLayout: null,
    activeRoute: null,
  };
}

export const PER_WINDOW_STATE_CAPABILITIES: PerWindowStateCapabilities = {
  schemaVersion: 2,
  features: ["tab-strip-layout-v2", "active-route-v1"],
};

const DURABLE_PER_WINDOW_STATE_CAPABILITIES: PerWindowStateCapabilities = {
  ...PER_WINDOW_STATE_CAPABILITIES,
  features: [
    ...PER_WINDOW_STATE_CAPABILITIES.features,
    "landing-draft-reference-move-v1",
  ],
};

export class PerWindowState {
  private readonly events = new EventEmitter();
  private readonly store: DesktopStateStore | null;
  private readonly snapshots = new Map<string, PerWindowSnapshot>();

  constructor(store: DesktopStateStore | null) {
    this.store = store;
  }

  get(windowId: string): PerWindowSnapshot {
    const snapshot =
      this.store === null
        ? this.snapshots.get(windowId)
        : this.store.getWindowSnapshots()[windowId];
    return snapshot ?? createEmptyPerWindowSnapshot();
  }

  capabilities(): PerWindowStateCapabilities {
    return this.store === null
      ? PER_WINDOW_STATE_CAPABILITIES
      : DURABLE_PER_WINDOW_STATE_CAPABILITIES;
  }

  async update(
    windowId: string,
    patch: PerWindowStatePatch,
  ): Promise<PerWindowStateUpdateAcknowledgement> {
    let next: PerWindowSnapshot;
    if (this.store === null) {
      next = patchWindowSnapshot(this.get(windowId), patch);
      this.snapshots.set(windowId, next);
    } else {
      next = await this.store.setWindowSnapshot(
        windowId,
        (current) => patchWindowSnapshot(current, patch),
      );
    }
    this.events.emit("change", {
      windowId,
      snapshot: next,
      origin: "update",
    });
    return {
      capabilities: this.capabilities(),
      revision: next.revision ?? 0,
    };
  }

  async flushDraftTopology(
    windowId: string,
    ref: LandingDraftReference,
  ): Promise<FlushWindowDraftTopologyResult> {
    return this.store === null
      ? { result: "unavailable" }
      : this.store.flushDraftTopology(windowId, ref);
  }

  async updateDraftReferences(
    windowId: string,
    request: UpdateWindowDraftReferencesRequest,
  ): Promise<WindowDraftTopologyResult> {
    if (this.store === null) return { result: "unavailable" };
    const result = await this.store
      .updateDraftReferences(windowId, request)
      .catch((): WindowDraftTopologyResult => ({ result: "unavailable" }));
    if (result.result === "committed") this.emitDraftTopology(windowId);
    return result;
  }

  async moveDraftReference(
    sourceWindowId: string,
    request: MoveWindowDraftReferenceRequest,
    destinationRoute: string,
  ): Promise<MoveWindowDraftReferenceResult> {
    if (this.store === null) return { result: "unavailable" };
    const result = await this.store
      .moveDraftReference(sourceWindowId, request, destinationRoute)
      .catch((): MoveWindowDraftReferenceResult => ({ result: "unavailable" }));
    if (result.result === "moved" && !result.replayed) {
      this.emitDraftTopology(sourceWindowId);
      this.emitDraftTopology(result.destinationWindowId);
    }
    return result;
  }

  private emitDraftTopology(windowId: string): void {
    this.events.emit("change", {
      windowId,
      snapshot: this.get(windowId),
      origin: "draft-topology",
    });
  }

  clear(windowId: string): void {
    const emit = (): void => {
      this.events.emit("change", {
        windowId,
        snapshot: createEmptyPerWindowSnapshot(),
        origin: "clear",
      });
    };
    if (this.store === null) {
      this.snapshots.delete(windowId);
      emit();
    } else {
      void this.store.deleteWindowSnapshot(windowId).then(emit, () => undefined);
    }
  }

  on(event: "change", listener: PerWindowStateListener): void {
    this.events.on(event, listener);
  }

  off(event: "change", listener: PerWindowStateListener): void {
    this.events.off(event, listener);
  }
}

function patchWindowSnapshot(
  current: PerWindowSnapshot,
  patch: PerWindowStatePatch,
): PerWindowSnapshot {
  const legacyDrafts = current.draftTopology === undefined;
  return {
    ...current,
    revision: (current.revision ?? 0) + 1,
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
    landingDrafts:
      legacyDrafts && "landingDrafts" in patch
        ? uniqueLandingDrafts(patch.landingDrafts ?? [])
        : current.landingDrafts,
    activeLandingDraftId:
      legacyDrafts && "activeLandingDraftId" in patch
        ? (patch.activeLandingDraftId ?? null)
        : current.activeLandingDraftId,
    tabStripLayout:
      "tabStripLayout" in patch
        ? (patch.tabStripLayout ?? null)
        : (current.tabStripLayout ?? null),
    activeRoute:
      "activeRoute" in patch
        ? (patch.activeRoute ?? null)
        : (current.activeRoute ?? null),
  };
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
