import type { ReactNode } from "react";
import { BootstrapAttemptDetails } from "@/components/host/bootstrap-attempt-details";
import { summariseBootstrapAttempts } from "@/components/host/bootstrap-attempt-summary";
import { useRunnerTraycerHostStatusQuery } from "@/hooks/runner/use-runner-traycer-host-status-query";

/** A single fresh read, though - never the cached snapshot. */
export function LocalBootstrapAttempts(): ReactNode {
  const status = useRunnerTraycerHostStatusQuery({
    pollIntervalMs: null,
    onMount: "fresh-read",
  });
  // A read we could not take is narrated as nothing, not as an older attempt: the card around this still has its
  // heading, the error, Retry and the log path, so the user is not left without the affordance that matters.
  if (!status.isFetchedAfterMount || !status.isSuccess) return null;
  const summary = summariseBootstrapAttempts(status.data.bootstrapMarkers);
  if (summary === null) return null;
  return (
    <BootstrapAttemptDetails
      summary={summary}
      bootstrapLogPath={status.data.bootstrapLogPath}
    />
  );
}
