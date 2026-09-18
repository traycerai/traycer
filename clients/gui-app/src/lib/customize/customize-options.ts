import { useSyncExternalStore, type ReactNode } from "react";
import type { AnalyticsSetting } from "@/lib/analytics";
import type { CustomizeSettingId } from "@/lib/customize/catalog";
import type { LayoutPatch } from "@/lib/customize/history";
import type { LayoutOverride } from "@/lib/layout-overrides";
import type { HotspotInstance } from "@/stores/customize/customize-store";

export interface CustomizeOptionSpec {
  readonly value: string;
  readonly label: string;
  readonly picture: (() => ReactNode) | null;
  readonly override: LayoutOverride;
  readonly disabled?: boolean;
}
interface ControlBase {
  readonly id: string;
  readonly label: string;
  readonly touches: ReadonlyArray<keyof LayoutPatch>;
  readonly analytics: AnalyticsSetting;
}
export type CustomizeControl = ControlBase &
  (
    | {
        readonly kind: "choice";
        readonly value: string;
        readonly options: ReadonlyArray<CustomizeOptionSpec>;
        readonly change: (value: string) => void;
      }
    | {
        readonly kind: "toggle";
        readonly checked: boolean;
        readonly pictures: ReadonlyArray<CustomizeOptionSpec>;
        readonly change: (checked: boolean) => void;
      }
    | {
        readonly kind: "multi";
        readonly values: ReadonlyArray<string>;
        readonly options: ReadonlyArray<CustomizeOptionSpec>;
        readonly lastItemHeld: boolean;
        readonly change: (values: ReadonlyArray<string>) => void;
        /**
         * Reorders `options` itself (a complete order over every item, not just
         * the selected ones) rather than the selection. Absent for a plain
         * checklist with no meaningful order of its own (`sidebar.resourceChips`).
         */
        readonly moveItem: ((value: string, direction: -1 | 1) => void) | null;
      }
    | {
        readonly kind: "composite";
        readonly primary: CustomizeControl;
        readonly more: ReadonlyArray<CustomizeControl>;
      }
  );
export interface CustomizeMove {
  readonly id: string;
  readonly label: string;
  readonly announcement: string;
  readonly disabled: boolean;
  readonly touches: ReadonlyArray<keyof LayoutPatch>;
  readonly analytics: AnalyticsSetting;
  readonly run: () => void;
}
/** A drop the setting recognises but will not allow - `reason` is spoken over
 *  the live region instead of applying a move. Distinct from `null`, which is
 *  simply not a drop this setting has an opinion about (wrong group, no
 *  target) and reverts silently per the drag contract. */
export interface CustomizeDropRefusal {
  readonly refused: string;
}
export interface CustomizeDrag {
  readonly group: string;
  readonly axis: "horizontal" | "vertical" | "both";
  /** Resolve against current stores at drop time; null is an invalid drop. */
  readonly resolveDrop: (
    overId: string,
  ) => CustomizeMove | CustomizeDropRefusal | null;
}
export interface CustomizeOptions {
  readonly state: string;
  readonly control: CustomizeControl | null;
  readonly moves: ReadonlyArray<CustomizeMove>;
  readonly drag: CustomizeDrag | null;
}
export type CustomizeOptionsFactory = (
  instance: HotspotInstance,
) => CustomizeOptions;
const registry = new Map<CustomizeSettingId, CustomizeOptionsFactory>();
const listeners = new Set<() => void>();
let version = 0;
function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}
export function registerCustomizeOptions(
  id: CustomizeSettingId,
  factory: CustomizeOptionsFactory,
): () => void {
  registry.set(id, factory);
  changed();
  return () => {
    if (registry.get(id) === factory) {
      registry.delete(id);
      changed();
    }
  };
}
export function getCustomizeOptions(
  instance: HotspotInstance,
): CustomizeOptions | null {
  return registry.get(instance.settingId)?.(instance) ?? null;
}
export function useCustomizeOptionsRegistry(): void {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => version,
    () => version,
  );
}
