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
    // The host publishing during boot (the 2026-07-14 incident) arrives as an
    // onChange well after this subscription is installed, so bumping the
    // revision here refetches and surfaces it. Paired with `staleTime: 0` in
    // `useHostPickerList`, which stops a boot-time empty fetch from being
    // served fresh for the session - that pairing is the load-bearing fix.
    const subscription = directory.onChange(() => {
      setRevision((prev) => prev + 1);
    });
    return () => {
      subscription.dispose();
    };
  }, [directory]);

  return useHostPickerList(directoryId, revision);
}
