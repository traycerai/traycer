import { HostSection } from "@/components/home/host-workspace-selector/host-section";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useRefreshHostDirectoryOnOpen } from "@/hooks/host/use-refresh-host-directory-on-open";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useHostBinding } from "@/lib/host";

/**
 * Host block shared by the worktree picker popovers (git diff panel,
 * terminal creation). Selecting a host swaps the app-wide active host
 * via the directory binding; the host-scoped folder queries underneath
 * refetch automatically, so consumers need no extra wiring.
 */
export function WorktreePickerHostSection() {
  const directoryList = useHostDirectoryList();
  const activeHostId = useReactiveActiveHostId();
  const binding = useHostBinding();
  const directory = binding === null ? null : binding.directory;
  useRefreshHostDirectoryOnOpen(true, directory);

  const handleSelectHost = (hostId: string): void => {
    if (binding === null) return;
    binding.directory.selectById(hostId);
  };

  return (
    <div className="border-b border-border/60 p-2.5">
      <HostSection
        entries={directoryList.data ?? []}
        activeHostId={activeHostId}
        onSelect={handleSelectHost}
      />
    </div>
  );
}
