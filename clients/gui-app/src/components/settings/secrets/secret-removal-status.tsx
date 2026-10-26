import type { ReactNode } from "react";
import type { EnvironmentSecretRemovalV12 } from "@traycer/protocol/host/environment-schemas";
import { failedHostsText } from "@/components/settings/secrets/secret-removal-lines";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";

/**
 * A removal still under way, collapsed to one line on the secret's row. The
 * three stages it passes through (access revoked, cleanup requested,
 * destroyed) are Details' to show; the row says only that the value is no
 * longer usable and which hosts still hold a copy, naming first a host that
 * couldn't delete its copy.
 */
export function SecretRemovalStatus(props: {
  readonly removal: EnvironmentSecretRemovalV12;
  /** A host's name by its id, for a target the removal names by id only. */
  readonly hostName: (hostId: string) => string;
  readonly pending: boolean;
  readonly onRetry: () => void;
}): ReactNode {
  return (
    <p
      role="status"
      className="text-ui-xs text-muted-foreground"
      data-testid="secret-removal-status"
    >
      {removalRowLine(props.removal, props.hostName)}
      {props.removal.outcome === "destroyed" ? null : (
        <>
          {" · "}
          <Button
            type="button"
            variant="link"
            size="inline-xs"
            disabled={props.pending}
            onClick={props.onRetry}
          >
            Retry
            {props.pending ? (
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
                tone="muted"
              />
            ) : null}
          </Button>
        </>
      )}
    </p>
  );
}

function removalRowLine(
  removal: EnvironmentSecretRemovalV12,
  hostName: (hostId: string) => string,
): string {
  const nameOf = (target: EnvironmentSecretRemovalV12["targets"][number]) =>
    target.hostName ??
    (target.hostId === null ? null : hostName(target.hostId)) ??
    "your host";
  const failed = failedHostsText(removal, nameOf);
  if (failed !== null) return `Removing · no longer usable · ${failed}`;
  const waiting = removal.targets.filter(
    (target) => target.target === "host" && target.state === "requested",
  );
  if (waiting.length === 1) {
    return `Removing · no longer usable · waiting for ${nameOf(waiting[0])} to delete its copy`;
  }
  if (waiting.length > 1) {
    return `Removing · no longer usable · waiting for ${waiting.length} hosts to delete their copies`;
  }
  return "Removing · no longer usable";
}
