import { useMemo, useState } from "react";
import { AdvancedSection } from "@/components/settings/panels/host-settings-advanced-section";
import { AvailableVersionsList } from "@/components/settings/panels/host-settings-available-versions-list";
import { HostSettingsDisclosure } from "@/components/settings/panels/host-settings-disclosure";
import {
  serviceDescription,
  VERSION_LIST_PREVIEW,
} from "@/components/settings/panels/host-settings-panel-model";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import type {
  HostAvailableSnapshot,
  HostAvailableVersionEntry,
  HostRegistryUpdateState,
  ServiceStatusSnapshot,
} from "@traycer-clients/shared/platform/runner-host";

interface AdvancedDisclosureProps {
  readonly installedVersion: string | null;
  readonly availableSnapshot: HostAvailableSnapshot | undefined;
  readonly availablePending: boolean;
  readonly availableErrorMessage: string | null;
  readonly availableFetching: boolean;
  readonly registryState: HostRegistryUpdateState | undefined;
  readonly statusState: ServiceStatusSnapshot["state"] | undefined;
  readonly anyPending: boolean;
  readonly registerPending: boolean;
  readonly deregisterPending: boolean;
  readonly onInstallVersion: (version: string) => void;
  readonly onRegisterService: () => void;
  readonly onDeregisterService: () => void;
  readonly onRefreshAvailable: () => void;
}

export function AdvancedDisclosure(props: AdvancedDisclosureProps) {
  const {
    installedVersion,
    availableSnapshot,
    availablePending,
    availableErrorMessage,
    availableFetching,
    statusState,
    anyPending,
    registerPending,
    deregisterPending,
    onInstallVersion,
    onRegisterService,
    onDeregisterService,
    onRefreshAvailable,
  } = props;
  const [showAllVersions, setShowAllVersions] = useState(false);
  const visibleVersions = useMemo<readonly HostAvailableVersionEntry[]>(() => {
    if (availableSnapshot === undefined) return [];
    return showAllVersions
      ? availableSnapshot.versions
      : availableSnapshot.versions.slice(0, VERSION_LIST_PREVIEW);
  }, [availableSnapshot, showAllVersions]);
  return (
    <HostSettingsDisclosure label="Advanced" defaultOpen={false}>
      <div className="flex flex-col gap-6">
        <AdvancedSection
          title="OS service"
          description={serviceDescription(statusState)}
        >
          <Button
            variant="secondary"
            size="sm"
            disabled={anyPending}
            onClick={onRegisterService}
          >
            {registerPending ? (
              <AgentSpinningDots
                className="mr-2 size-3"
                testId={undefined}
                variant={undefined}
              />
            ) : null}
            Re-register
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={anyPending || statusState === "not-installed"}
            onClick={onDeregisterService}
          >
            {deregisterPending ? (
              <AgentSpinningDots
                className="mr-2 size-3"
                testId={undefined}
                variant={undefined}
              />
            ) : null}
            Deregister
          </Button>
        </AdvancedSection>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <div className="font-medium text-foreground">
              Pick a different version
            </div>
            <p className="text-ui-sm text-muted-foreground">
              Install a specific host version. Useful for pinning or rolling
              back.
            </p>
          </div>
          <AvailableVersionsList
            availableSnapshot={availableSnapshot}
            visibleVersions={visibleVersions}
            installedVersion={installedVersion}
            isPending={availablePending}
            errorMessage={availableErrorMessage}
            fetching={availableFetching}
            anyPending={anyPending}
            showAllVersions={showAllVersions}
            onToggleShowAll={() => setShowAllVersions((v) => !v)}
            onInstallVersion={onInstallVersion}
            onRetry={onRefreshAvailable}
          />
        </div>
      </div>
    </HostSettingsDisclosure>
  );
}
