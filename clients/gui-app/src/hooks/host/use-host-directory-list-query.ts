import { useEffect, useState } from "react";
import { type UseQueryResult } from "@tanstack/react-query";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { useHostBinding } from "@/lib/host";
import {
  registerHostPickerDirectory,
  useHostPickerList,
} from "@/hooks/host/use-host-picker-list";

/**
 * Hook form of `useHostPickerList` that internalizes directory binding,
 * registration, and revision bumping. Used by the combined host/folder
 * chip; the legacy host-picker dialog uses `useHostPickerList` directly.
 */
export function useHostDirectoryList(): UseQueryResult<
  readonly HostDirectoryEntry[]
> {
  const binding = useHostBinding();
  const directory = binding === null ? null : binding.directory;
  const directoryId =
    directory === null ? null : registerHostPickerDirectory(directory);
  const [revision, setRevision] = useState<number>(0);

  useEffect(() => {
    if (directory === null) return;
    const subscription = directory.onChange(() => {
      setRevision((prev) => prev + 1);
    });
    return () => {
      subscription.dispose();
    };
  }, [directory]);

  return useHostPickerList(directoryId, revision);
}
