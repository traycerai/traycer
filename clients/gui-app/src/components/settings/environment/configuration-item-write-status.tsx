import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  pendingWriteInScope,
  type ConfigurationItemWrite,
  type ConfigurationItemWriteFailure,
  type ConfigurationItemWrites,
  type ConfigurationWriteScope,
} from "./configuration-item-writes";

export function ConfigurationItemWriteStatus(props: {
  readonly writes: ConfigurationItemWrites;
  readonly scope: ConfigurationWriteScope;
}): ReactNode {
  const { changedAgain, checking, retry } = props.writes;
  const pending = pendingWriteInScope(props.writes, props.scope);
  if (pending === null)
    return changedAgain === null || !props.scope(changedAgain) ? null : (
      <p role="status" className="text-ui-xs text-muted-foreground">
        {changedAgainMessage(changedAgain.action)}
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

function changedAgainMessage(action: "put" | "remove"): string {
  return action === "remove"
    ? "Removed. These settings changed again."
    : "Saved. These settings changed again.";
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
