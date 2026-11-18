import { use } from "react";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";

export function useMaybeOpenEpicHandle(): OpenEpicStoreHandle | null {
  return use(EpicSessionContext);
}

export function useOpenEpicHandle(): OpenEpicStoreHandle {
  const value = useMaybeOpenEpicHandle();
  if (value === null) {
    throw new Error(
      "useOpenEpicHandle must be called inside <EpicSessionProvider>.",
    );
  }
  return value;
}
