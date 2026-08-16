import type { ReactNode } from "react";
import { HostSection } from "@/components/home/host-workspace-selector/host-section";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";
import { NO_HOST_OPTION_REFUSALS } from "@/components/settings/host-scope/host-option-model";
import { useRefreshHostDirectoryOnOpen } from "@/hooks/host/use-refresh-host-directory-on-open";
import { useHostBinding } from "@/lib/host";

/**
 * Host block shared by the worktree picker popovers (git diff panel,
 * terminal creation, file tree). Selecting a host swaps the app-wide active
 * host via the directory binding; the host-scoped folder queries underneath
 * refetch automatically, so consumers need no extra wiring.
 *
 * The list is `useHostOptions`, not the raw directory: these popovers now
 * answer "what hosts do I have" the same way Settings does, including the ones
 * this client cannot dial — which `HostSection` renders inert with the reason,
 * since binding the window to an unreachable host is not a legal answer.
 */
export function WorktreePickerHostSection(): ReactNode {
  const options = useHostOptions();
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
        hosts={options.hosts}
        activeHostId={options.activeHostId}
        onSelect={handleSelectHost}
        refusalByHostId={NO_HOST_OPTION_REFUSALS}
        inertExceptHostId={null}
        disabled={false}
        isLoading={options.isLoading}
        listsFailed={options.listsFailed}
        onRetryLists={options.retryLists}
      />
    </div>
  );
}
