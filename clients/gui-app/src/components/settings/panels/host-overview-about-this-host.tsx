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
 * Installation ▸ About this host: what the ACCOUNT knows about this machine -
 * its id, when it joined, when it was last seen, the version it last reported
 * and its platform.
 *
 * Read from the account's host record, never from the host, so it reads the
 * same whether or not the host can be reached - which is exactly when someone
 * comes here for the host id or to see when it was last alive. A host the
 * account has no record of gets no group (the caller passes none), the way it
 * gets no Danger zone.
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
          tone={about.online ? "success" : "default"}
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
