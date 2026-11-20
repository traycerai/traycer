import { computerNameFromLabel } from "@/lib/host/host-name";
import { useCallback, useMemo } from "react";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";

export function useProfileMoveComputerNames(): (
  hostId: string | null,
) => string {
  const directory = useHostDirectoryList();
  const names = useMemo(
    () => new Map(directory.data?.map((entry) => [entry.hostId, entry.label])),
    [directory.data],
  );
  return useCallback(
    (hostId: string | null): string =>
      hostId === null
        ? ""
        : computerNameFromLabel(names.get(hostId) ?? null, hostId),
    [names],
  );
}
