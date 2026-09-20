import { create } from "zustand";
import type { CustomizeSettingId } from "@/lib/customize/catalog";
import type { HistoryEntry } from "@/lib/customize/history";
import type { SettingsSectionId } from "@/lib/settings-sections";

export type Scene = "in-place" | "sample";
export type Opener =
  | { kind: "settings-modal"; section: SettingsSectionId; scrollTop: number }
  | {
      kind: "settings-tab";
      tabId: string;
      section: SettingsSectionId;
      scrollTop: number;
    }
  | { kind: "none" };
export type ExitReason =
  | "done"
  | "escape"
  | "tab-switch"
  | "studio-closed"
  | "below-md"
  | "switch-off"
  | "lease-lost";
export type InstanceKey = string;
export interface HotspotInstance {
  readonly key: InstanceKey;
  readonly settingId: CustomizeSettingId;
  readonly sceneId: string;
  readonly tileId: string | null;
  readonly node: HTMLElement;
  readonly ghost: boolean;
  readonly condition: string | null;
}
export interface CustomizeState {
  session: {
    scene: Scene;
    opener: Opener;
    startedAt: number;
    pointerEntry?: boolean;
  } | null;
  instances: ReadonlyMap<InstanceKey, HotspotInstance>;
  activeKey: InstanceKey | null;
  popoverKey: InstanceKey | null;
  invoker: InstanceKey | null;
  disclosure: string | null;
  pendingTarget: CustomizeSettingId | null;
  preferredTileId: string | null;
  history: {
    past: ReadonlyArray<HistoryEntry>;
    future: ReadonlyArray<HistoryEntry>;
  };
  search: { query: string; activeIndex: number };
  lockedBy: "none" | "other-window";
  announcement: string;
  register: (instance: HotspotInstance) => void;
  unregister: (key: InstanceKey, node: HTMLElement) => void;
  setActive: (key: InstanceKey | null) => void;
  openPopover: (
    key: InstanceKey,
    invoker: InstanceKey,
    disclosure: string | null,
  ) => void;
  closePopover: () => void;
  setSearch: (query: string, activeIndex: number) => void;
  announce: (message: string) => void;
}

export const useCustomizeStore = create<CustomizeState>((set) => ({
  session: null,
  instances: new Map(),
  activeKey: null,
  popoverKey: null,
  invoker: null,
  disclosure: null,
  pendingTarget: null,
  preferredTileId: null,
  history: { past: [], future: [] },
  search: { query: "", activeIndex: -1 },
  lockedBy: "none",
  announcement: "",
  register: (instance) =>
    set((state) => {
      if (state.instances.get(instance.key) === instance) return state;
      const instances = new Map(state.instances);
      instances.set(instance.key, instance);
      return { instances };
    }),
  unregister: (key, node) =>
    set((state) => {
      if (state.instances.get(key)?.node !== node) return state;
      const instances = new Map(state.instances);
      instances.delete(key);
      return { instances };
    }),
  setActive: (activeKey) => set({ activeKey }),
  openPopover: (popoverKey, invoker, disclosure) =>
    set({ popoverKey, activeKey: popoverKey, invoker, disclosure }),
  closePopover: () => set({ popoverKey: null, disclosure: null }),
  setSearch: (query, activeIndex) =>
    set({ search: { query, activeIndex }, pendingTarget: null }),
  announce: (announcement) => set({ announcement }),
}));

export function selectedInstances(
  state: Pick<CustomizeState, "instances" | "preferredTileId">,
): ReadonlyArray<HotspotInstance> {
  const selected = new Map<CustomizeSettingId, HotspotInstance>();
  const independent: HotspotInstance[] = [];
  for (const instance of state.instances.values()) {
    // Provider/panel ids identify subjects, not competing chat tiles.
    if (
      instance.tileId === null ||
      instance.settingId === "statusBar.provider" ||
      instance.settingId === "sidebar.panel"
    ) {
      independent.push(instance);
      continue;
    }
    if (
      !selected.has(instance.settingId) ||
      instance.tileId === state.preferredTileId
    )
      selected.set(instance.settingId, instance);
  }
  return [...independent, ...selected.values()].sort((a, b) =>
    a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_PRECEDING
      ? 1
      : -1,
  );
}
