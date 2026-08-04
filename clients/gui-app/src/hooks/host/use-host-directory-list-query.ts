import { useEffect } from "react";
import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { useHostBinding } from "@/lib/host";
import {
  registerHostPickerDirectory,
  useHostPickerList,
} from "@/hooks/host/use-host-picker-list";
import { uiQueryKeys } from "@/lib/query-keys";

/**
 * Hook form of `useHostPickerList` that internalizes directory binding,
 * registration, and change wiring. Used by the combined host/folder
 * chip; the legacy host-picker dialog uses `useHostPickerList` directly.
 */
export function useHostDirectoryList(): UseQueryResult<
  readonly HostDirectoryEntry[]
> {
  const binding = useHostBinding();
  const queryClient = useQueryClient();
  const directory = binding === null ? null : binding.directory;
  const directoryId =
    directory === null ? null : registerHostPickerDirectory(directory);

  useEffect(() => {
    if (directory === null || directoryId === null) return;
    // The host publishing during boot (the 2026-07-14 incident) arrives as an
    // onChange well after this subscription is installed, so invalidating here
    // refetches and surfaces it. Paired with `staleTime: 0` in
    // `useHostPickerList`, which stops a boot-time empty fetch from being
    // served fresh for the session - that pairing is the load-bearing fix.
    // Invalidate the SAME key rather than minting a new one (the old
    // revision-in-key design): a same-key refetch keeps the previous `data`,
    // so consumers never regress to a loading state on a directory emit.
    const subscription = directory.onChange(() => {
      void queryClient.invalidateQueries({
        queryKey: uiQueryKeys.hostPicker(directoryId),
      });
    });
    return () => {
      subscription.dispose();
    };
  }, [directory, directoryId, queryClient]);

  return useHostPickerList(directoryId);
}
