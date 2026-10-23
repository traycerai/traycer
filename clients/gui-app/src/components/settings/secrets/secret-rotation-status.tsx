import { useState, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useHostQuery } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";
import {
  secretRotationSettled,
  secretRotationStatus,
  type SecretRotationLine,
} from "@/lib/sandboxes/secret-rotation-line";
import { cn } from "@/lib/utils";

const TONE: Readonly<Record<SecretRotationLine["tone"], string>> = {
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  muted: "text-muted-foreground",
};

/**
 * A secret's current rotation on Settings ▸ Personal ▸ Secrets: "New value
 * accepted, closing old sessions." until every class and host has proved the
 * old value out of use, then "New value enforced." with each one's proof.
 * Re-read every few seconds only while it is still moving.
 */
export function SecretRotationStatus(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly secretId: string;
  readonly hostName: (hostId: string) => string;
}): ReactNode {
  const [moving, setMoving] = useState(true);
  const rotation = useHostQuery<
    HostRpcRegistry,
    "environment.secrets.rotation"
  >({
    cacheKeyIdentity: undefined,
    client: props.client,
    method: "environment.secrets.rotation",
    params: { secretId: props.secretId, environmentId: null },
    options: { enabled: true, poll: moving },
  });
  const current = rotation.data?.rotation;
  // Derived during render, not in an effect: a settled answer stops the poll
  // on the same render that shows it.
  const stillMoving = current === undefined || !secretRotationSettled(current);
  if (stillMoving !== moving) setMoving(stillMoving);
  if (current === undefined) return null;
  const status = secretRotationStatus(current, props.hostName);
  if (status === null) return null;
  return (
    <div
      className="flex flex-col gap-0.5"
      data-testid="secret-rotation-status"
      role="status"
    >
      <p
        className={cn("max-w-[72ch] text-ui-xs", TONE[status.headline.tone])}
        data-testid="secret-rotation-headline"
      >
        {status.headline.text}
      </p>
      {status.producers.length === 0 ? null : (
        <ul className="flex flex-col pl-3 text-ui-xs text-muted-foreground">
          {status.producers.map((line) => (
            <li key={line.key} data-testid="secret-rotation-producer">
              {line.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
