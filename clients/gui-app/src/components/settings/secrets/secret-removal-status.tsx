import type { ReactNode } from "react";
import type { EnvironmentSecretRemoval } from "@traycer/protocol/host/environment-schemas";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import {
  detailsTime,
  removalLabel,
} from "@/components/settings/details/details-copy";

export function SecretRemovalStatus(props: {
  readonly removal: EnvironmentSecretRemoval;
  readonly pending: boolean;
  readonly onRetry: () => void;
}): ReactNode {
  const { removal } = props;
  return (
    <div
      role="status"
      className="flex flex-col items-start gap-1"
      data-testid="secret-removal-status"
    >
      <p className="text-ui-xs font-medium">{removalLabel(removal.outcome)}</p>
      <p className="text-ui-xs text-muted-foreground">
        Access revoked · {detailsTime(removal.revokedAt)}
      </p>
      <ul className="flex flex-col gap-1 text-ui-xs text-muted-foreground">
        {removal.targets.map((target) => (
          <li key={`${target.target}:${target.hostId ?? ""}`}>
            {target.target === "host"
              ? (target.hostName ?? "Your hosts")
              : "Stored copies"}{" "}
            · {target.state === "confirmed" ? "Destroyed" : "Cleanup requested"}{" "}
            · {detailsTime(target.at)}
          </li>
        ))}
      </ul>
      {removal.destroyedAt === null ? null : (
        <p className="text-ui-xs text-muted-foreground">
          Destroyed · {detailsTime(removal.destroyedAt)}
        </p>
      )}
      {removal.outcome === "destroyed" ? null : (
        <Button
          type="button"
          variant="outline"
          size="sm"
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
      )}
    </div>
  );
}
