import { useEffect } from "react";
import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { useHostBinding } from "@/lib/host";
import {
  registerHostPickerDirectory,
  useHostPickerListQuery,
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
  return useHostDirectoryListQuery(true);
}

/**
 * `useHostDirectoryList` with the observer's subscription under the caller's
 * control.
 *
 * `subscribed: false` reads the cached list and joins nothing: no observer on
 * the query, no mount-time refetch (the query is deliberately stale on mount,
 * see `useHostPickerList`), and no `onChange` -> invalidate listener of its
 * own. It is for a consumer whose LIVE reading arrives from a provider higher
 * up (`useHostDirectoryReading`): a sidebar row mounting in a long list must
 * not add its own observer, refetch and invalidate listener per row when the
 * panel above it already holds all three. A subscribed caller keeps the
 * 2026-07-14 pairing intact, so the provider is exactly as live as every
 * direct consumer.
 */
export function useHostDirectoryListQuery(
  subscribed: boolean,
): UseQueryResult<readonly HostDirectoryEntry[]> {
  const binding = useHostBinding();
  const queryClient = useQueryClient();
  const directory = binding === null ? null : binding.directory;
  const directoryId =
    directory === null ? null : registerHostPickerDirectory(directory);

  useEffect(() => {
    if (!subscribed || directory === null || directoryId === null) return;
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
  }, [subscribed, directory, directoryId, queryClient]);

  return useHostPickerListQuery(directoryId, subscribed);
}
