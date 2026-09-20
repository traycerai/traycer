import {
  getCustomizeOptions,
  type CustomizeDropRefusal,
  type CustomizeMove,
} from "@/lib/customize/customize-options";
import { useCustomizeStore } from "@/stores/customize/customize-store";

let suppressClick = false;
export function suppressNextCustomizeClick(): void {
  suppressClick = true;
  window.setTimeout(() => {
    suppressClick = false;
  }, 0);
}
export function consumeCustomizeDragClick(): boolean {
  const suppressed = suppressClick;
  suppressClick = false;
  return suppressed;
}
export function resolveCustomizeDrop(
  activeId: string,
  overId: string | null,
  overGroup: string | null,
): CustomizeMove | CustomizeDropRefusal | null {
  if (!overId || activeId === overId) return null;
  const instance = useCustomizeStore.getState().instances.get(activeId);
  if (!instance) return null;
  const drag = getCustomizeOptions(instance)?.drag;
  if (!drag || drag.group !== overGroup) return null;
  const result = drag.resolveDrop(overId);
  if (result === null) return null;
  if ("refused" in result) return result;
  return result.disabled ? null : result;
}
