import type { ReactNode } from "react";
import { HostSection } from "@/components/home/host-workspace-selector/host-section";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";
import { NO_HOST_OPTION_REFUSALS } from "@/components/settings/host-scope/host-option-model";
import { useRefreshHostDirectoryOnOpen } from "@/hooks/host/use-refresh-host-directory-on-open";
import { useSurfaceHostPin } from "@/hooks/host/use-surface-host-pin";
import { useHostBinding } from "@/lib/host";

/**
 * Host block shared by the worktree picker popovers (git diff panel,
 * terminal creation, file tree). Selecting a host writes this surface
 * instance's pin (`selection ?? effective`); it does not rebind the window.
 *
 * The list is `useHostOptions`, not the raw directory: these popovers answer
 * "what hosts do I have" the same way Settings does, including the ones this
 * client cannot dial — which `HostSection` renders inert with the reason.
 */
export interface WorktreePickerHostSectionProps {
  readonly surfaceKey: string;
}

export function WorktreePickerHostSection(
  props: WorktreePickerHostSectionProps,
): ReactNode {
  const options = useHostOptions();
  const pin = useSurfaceHostPin(props.surfaceKey);
  const binding = useHostBinding();
  const directory = binding === null ? null : binding.directory;
  useRefreshHostDirectoryOnOpen(true, directory);

  return (
    <div className="border-b border-border/60 p-2.5">
      <HostSection
        hosts={options.hosts}
        activeHostId={pin.resolvedHostId}
        onSelect={pin.setSelection}
        refusalByHostId={NO_HOST_OPTION_REFUSALS}
        inertExceptHostId={null}
        disabled={false}
        isLoading={options.isLoading}
        listsFailed={options.listsFailed}
        onRetryLists={options.retryLists}
        intent="pin"
      />
    </div>
  );
}
