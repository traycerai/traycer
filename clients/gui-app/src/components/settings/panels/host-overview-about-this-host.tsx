import type { ReactNode } from "react";
import { HOST_OVERVIEW } from "@/components/settings/panels/host-overview.definitions";
import {
  HostOverviewFact,
  HostOverviewFacts,
} from "@/components/settings/panels/host-overview-facts";
import {
  abbreviateIdentifier,
  deriveAboutThisHost,
  type HostOverviewAboutSource,
} from "@/components/settings/panels/host-overview-installation-model";
import { SettingsGroup } from "@/components/settings/settings-group";

/**
 * Installation ▸ About this host: what the account knows about this machine.
 * It reads with or without a route. Last seen is the account's stamp, never
 * "Online now".
 */
export function HostOverviewAboutThisHost(
  props: HostOverviewAboutSource,
): ReactNode {
  const about = deriveAboutThisHost(props);
  return (
    <SettingsGroup
      group={HOST_OVERVIEW.definitions.aboutThisHost}
      showTitle
      tone="default"
      dataTestId="host-overview-about"
      fill={false}
    >
      <HostOverviewFacts testId="host-overview-about-facts">
        <HostOverviewFact
          label="Host ID"
          value={abbreviateIdentifier(about.hostId)}
          kind="code"
          tone="default"
          copy={{ value: about.hostId, label: "Copy host ID" }}
          testId="host-overview-about-host-id"
        />
        <HostOverviewFact
          label="Added to account"
          value={about.addedToAccount}
          kind="text"
          tone="default"
          copy={null}
          testId="host-overview-about-added"
        />
        <HostOverviewFact
          label="Last seen"
          value={about.lastSeen}
          kind="text"
          tone="default"
          copy={null}
          testId="host-overview-about-last-seen"
        />
        <HostOverviewFact
          label="Last reported version"
          value={about.lastReportedVersion}
          kind="code"
          tone="default"
          copy={null}
          testId="host-overview-about-version"
        />
        <HostOverviewFact
          label="Platform"
          value={about.platform}
          kind="text"
          tone="default"
          copy={null}
          testId="host-overview-about-platform"
        />
      </HostOverviewFacts>
    </SettingsGroup>
  );
}
