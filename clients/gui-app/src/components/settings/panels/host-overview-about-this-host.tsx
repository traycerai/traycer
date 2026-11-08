import type { ReactNode } from "react";
import { HostOverviewFact } from "@/components/settings/panels/host-overview-facts";
import {
  deriveAboutThisHost,
  type HostOverviewAboutSource,
} from "@/components/settings/panels/host-overview-installation-model";

/** Account facts in Installation Details remain available while the host is offline. */
export function HostOverviewAboutThisHost(
  props: HostOverviewAboutSource,
): ReactNode {
  const about = deriveAboutThisHost(props);
  return (
    <>
      <HostOverviewFact
        label="Added to account"
        value={about.addedToAccount}
        kind="text"
        tone="default"
        copy={null}
        testId="host-overview-about-added"
      />
      {about.unseenLine === null ? null : (
        <div>
          <dt className="sr-only">Last seen</dt>
          <dd
            className="min-w-0 break-words text-ui-sm text-muted-foreground"
            data-testid="host-overview-about-last-seen"
          >
            {about.unseenLine}
          </dd>
        </div>
      )}
    </>
  );
}
