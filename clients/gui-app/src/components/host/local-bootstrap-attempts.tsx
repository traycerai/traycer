import type { ReactNode } from "react";
import { BootstrapAttemptDetails } from "@/components/host/bootstrap-attempt-details";
import { summariseBootstrapAttempts } from "@/components/host/bootstrap-attempt-summary";
import { useRunnerTraycerHostStatusQuery } from "@/hooks/runner/use-runner-traycer-host-status-query";

/**
 * What the last bootstrap attempt tried, and where the full log lives - the
 * settled-failure diagnostics of THIS machine's host, read once and drawn.
 *
 * A single read, not a poll: while a user is staring at a failure card there
 * is nothing to gain from re-running the CLI underneath them, and the recovery
 * actions invalidate this query when they fire.
 *
 * Shared by the two surfaces that can be on screen for a failed local start -
 * the window narrator's settled arm and the gate's `provisioning-error` card.
 * It lived inside the narrator's host, and the gate's card, which WINS over
 * the narrator on exactly that state (see `gateCardReadiness`), had no attempt
 * panel and no log path at all - so the one launch that most needed the
 * bootstrap.log path was the one that did not get it.
 */
export function LocalBootstrapAttempts(): ReactNode {
  const status = useRunnerTraycerHostStatusQuery({ pollIntervalMs: null });
  if (status.data === undefined) return null;
  const summary = summariseBootstrapAttempts(status.data.bootstrapMarkers);
  if (summary === null) return null;
  return (
    <BootstrapAttemptDetails
      summary={summary}
      bootstrapLogPath={status.data.bootstrapLogPath}
    />
  );
}
