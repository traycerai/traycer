import type { ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { ArtifactVersionSettingsSection } from "@/components/settings/panels/artifact-version-settings-section";
import { HostImportMigrationSection } from "@/components/settings/panels/host-import-migration-section";
import { HostOverviewTabSections } from "@/components/settings/panels/host-overview-tabs";

/**
 * Overview ▸ Data: what this host keeps on its own disk, and bringing work in.
 */
export interface HostOverviewDataTabProps {
  /** The scope's own client; `null` while the scope cannot reach the host. */
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  /** Whether the scope can reach the host, and so whether a read may mount. */
  readonly usable: boolean;
}

export function HostOverviewDataTab(
  props: HostOverviewDataTabProps,
): ReactNode {
  return (
    <HostOverviewTabSections>
      {/* Everything about this host's OWN local data: the sessions on its disk
          waiting to be imported, and the SQLite tasks and epics still to reach
          cloud. Both moved off General, which is app-wide and so could only
          ever speak for whichever host the window pointed at.

          Gated on `usable` for the reason every host read on this page is - a
          hook mounted under a non-ready scope fires against the ambient host
          regardless of what a gate hides. The section applies a second,
          narrower check of its own: the stream beneath it must already name
          this host. */}
      {!props.usable ? null : (
        <HostImportMigrationSection hostId={props.hostId} />
      )}
      <ArtifactVersionSettingsSection
        client={props.client}
        hostId={props.hostId}
        enabled={props.usable}
      />
    </HostOverviewTabSections>
  );
}
