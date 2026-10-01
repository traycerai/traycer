import type { ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { HostScopeConnecting } from "@/components/settings/host-scope/host-scope-gate";
import { ArtifactVersionSettingsSection } from "@/components/settings/panels/artifact-version-settings-section";
import { HostFileEditSnapshotsSection } from "@/components/settings/panels/host-file-edit-snapshots-section";
import { HostImportMigrationSection } from "@/components/settings/panels/host-import-migration-section";
import { HostOverviewTabSections } from "@/components/settings/panels/host-overview-tabs";

/**
 * Overview ▸ Data: what this host keeps on its own disk, and bringing work in.
 */
export interface HostOverviewDataTabProps {
  /** The scope's own client; `null` while the scope cannot reach the host. */
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly hostName: string;
  /** Connecting the scope, or waiting for an expected host restart. */
  readonly connecting: boolean;
  /** Whether the scope can reach the host, and so whether a read may mount. */
  readonly usable: boolean;
}

export function HostOverviewDataTab(
  props: HostOverviewDataTabProps,
): ReactNode {
  const ready = !props.connecting && props.usable && props.client !== null;
  let fallback: ReactNode = null;
  if (props.connecting) {
    fallback = <HostScopeConnecting hostName={props.hostName} />;
  } else if (!ready) {
    fallback = (
      <p className="text-ui-sm text-muted-foreground">
        These live on {props.hostName}'s disk, so they need a connection to it.
      </p>
    );
  }

  return (
    <>
      {fallback === null ? null : (
        <HostOverviewTabSections>{fallback}</HostOverviewTabSections>
      )}
      {/* Keep the stateful host sections mounted through a same-host disconnect
          or restart. The host-bound clients go null while the sections are
          concealed, so no new host read or mutation starts through an old route. */}
      <div hidden={!ready}>
        <HostOverviewTabSections>
          {/* Everything about this host's OWN local data: the sessions on its disk
          waiting to be imported, and the SQLite tasks and epics still to reach
          cloud. Both moved off General, which is app-wide and so could only
          ever speak for whichever host the window pointed at.

          The import section mounts only when ready - a stream hook mounted
          under a non-ready scope could read the ambient host despite the
          concealed wrapper. The section also checks that the stream beneath
          it names this host. */}
          {ready ? <HostImportMigrationSection hostId={props.hostId} /> : null}
          <ArtifactVersionSettingsSection
            client={ready ? props.client : null}
            hostId={props.hostId}
            enabled={ready}
          />
          <HostFileEditSnapshotsSection
            client={ready ? props.client : null}
            hostId={props.hostId}
            hostName={props.hostName}
            enabled={ready}
          />
        </HostOverviewTabSections>
      </div>
    </>
  );
}
