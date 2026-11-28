import { useCallback, useSyncExternalStore } from "react";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import {
  writeFieldKey,
  type WriteField,
} from "@/stores/epics/open-epic/write-field-key";

export function readWriteFieldBusy(
  handle: OpenEpicStoreHandle | null,
  field: WriteField,
  artifactId: string | null,
): boolean {
  if (artifactId === null && field !== "epic-title") return false;
  return (
    handle?.store.getState().occupiedWriteFields[
      writeFieldKey(field, artifactId)
    ] === true
  );
}

export function useWriteFieldBusy(
  handle: OpenEpicStoreHandle | null,
  field: WriteField,
  artifactId: string | null,
): boolean {
  const subscribe = useCallback(
    (notify: () => void) =>
      handle !== null && (field === "epic-title" || artifactId !== null)
        ? handle.store.subscribe(notify)
        : () => {},
    [handle, field, artifactId],
  );
  const read = useCallback(
    () => readWriteFieldBusy(handle, field, artifactId),
    [handle, field, artifactId],
  );
  return useSyncExternalStore(subscribe, read, read);
}

export function useRegisteredTaskTitleBusy(epicId: string | null): boolean {
  const registry = getOpenEpicRegistry();
  const handle = useSyncExternalStore(
    (notify) => registry.subscribe(notify),
    () => (epicId === null ? null : registry.peek(epicId)),
    () => null,
  );
  return useWriteFieldBusy(handle, "epic-title", null);
}
