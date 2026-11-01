import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { stageFallbackHostLine } from "@/lib/sandboxes/sandbox-strings";

/**
 * The action that takes a stage off a composer, named for `hostId`, the host
 * its chip falls back to. Reads the directory the chip reads.
 */
export function useStageFallbackHostLine(hostId: string | null): string {
  const directoryList = useHostDirectoryList();
  const entry = directoryList.data?.find((row) => row.hostId === hostId);
  return stageFallbackHostLine(
    entry === undefined || entry.label.length === 0 ? null : entry.label,
  );
}
