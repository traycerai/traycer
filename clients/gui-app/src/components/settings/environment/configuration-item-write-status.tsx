import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type {
  ConfigurationItemWrite,
  ConfigurationItemWriteFailure,
  ConfigurationItemWrites,
} from "./configuration-item-writes";

export function ConfigurationItemWriteStatus(props: {
  readonly writes: ConfigurationItemWrites;
  readonly kind: ConfigurationItemWrite["kind"];
}): ReactNode {
  const { pending, changedAgain, checking, retry } = props.writes;
  if (pending?.write.kind !== props.kind)
    return changedAgain?.kind !== props.kind ? null : (
      <p role="status" className="text-ui-xs text-muted-foreground">
        Saved. These settings changed again.
      </p>
    );
  if (pending.accepted === null) return null;
  const message = acceptedWriteMessage(pending.write.action, checking);
  return (
    <p role="status" className="text-ui-xs text-muted-foreground">
      {message}
      {!checking ? (
        <Button type="button" variant="link" size="sm" onClick={retry}>
          Retry
        </Button>
      ) : null}
    </p>
  );
}

function acceptedWriteMessage(
  action: "put" | "remove",
  checking: boolean,
): string {
  if (action === "remove")
    return checking
      ? "Removed. Checking latest settings…"
      : "Removed, but latest settings haven't refreshed.";
  return checking
    ? "Saved. Checking latest settings…"
    : "Saved, but latest settings haven't refreshed.";
}

export function ConfigurationPendingWriteStatus(props: {
  readonly write: ConfigurationItemWrite | null;
}): ReactNode {
  const write = props.write;
  if (write === null) return null;
  let action = write.original === null ? "Adding" : "Saving";
  if (write.action === "remove") action = "Removing";
  return (
    <p role="status" className="text-ui-xs text-muted-foreground">
      {write.key} · {action}
    </p>
  );
}

export function ConfigurationItemWriteError(props: {
  readonly failure: ConfigurationItemWriteFailure | null;
}): ReactNode {
  return props.failure === null ? null : (
    <p role="alert" className="text-ui-xs text-destructive">
      {props.failure.message}
    </p>
  );
}
