import type { ReactNode } from "react";
import type { EnvironmentSecretRemoval } from "@traycer/protocol/host/environment-schemas";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";

/**
 * A removal still under way, collapsed to one line on the secret's row. The
 * three stages it passes through (access revoked, cleanup requested,
 * destroyed) are Details' to show; the row says only that the value is no
 * longer usable and which hosts still hold a copy.
 */
export function SecretRemovalStatus(props: {
  readonly removal: EnvironmentSecretRemoval;
  readonly pending: boolean;
  readonly onRetry: () => void;
}): ReactNode {
  return (
    <p
      role="status"
      className="text-ui-xs text-muted-foreground"
      data-testid="secret-removal-status"
    >
      {removalRowLine(props.removal)}
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

function removalRowLine(removal: EnvironmentSecretRemoval): string {
  const waiting = removal.targets.filter(
    (target) => target.target === "host" && target.state === "requested",
  );
  if (waiting.length === 1) {
    const [only] = waiting;
    return `Removing · no longer usable · waiting for ${only.hostName ?? "your host"} to delete its copy`;
  }
  if (waiting.length > 1) {
    return `Removing · no longer usable · waiting for ${waiting.length} hosts to delete their copies`;
  }
  return "Removing · no longer usable";
}
