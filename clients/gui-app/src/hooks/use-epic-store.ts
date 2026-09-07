/** Epic session store selector. Do not project chat message rows through this store. */
import { useStore } from "zustand";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import type { OpenEpicState } from "@/stores/epics/open-epic/store";

export function useEpicStore<T>(selector: (state: OpenEpicState) => T): T {
  const handle = useOpenEpicHandle();
  return useStore(handle.store, selector);
}
