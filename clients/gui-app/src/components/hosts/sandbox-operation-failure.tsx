import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type {
  SandboxRowOperation,
  SandboxRowVerb,
} from "@/hooks/sandboxes/use-sandbox-operation";
import {
  DETAILS,
  RETRY,
  sandboxVerbFailureLine,
} from "@/lib/sandboxes/sandbox-strings";
import { openSandboxDetails } from "@/stores/sandboxes/sandbox-details-store";

/** The same lasting outcome and remedies on every sandbox action surface. */
export function SandboxOperationFailure(props: {
  readonly sandboxId: string;
  readonly name: string;
  readonly operation: SandboxRowOperation | null;
  readonly busy: boolean;
  readonly onRetry: (verb: SandboxRowVerb) => void;
}): ReactNode {
  const { operation } = props;
  if (operation?.kind === "skipped") {
    return (
      <p role="status" className="w-full text-ui-xs text-muted-foreground">
        Skipped {props.name} · {operation.message}
      </p>
    );
  }
  if (operation?.kind !== "failed") return null;
  return (
    <div
      role="alert"
      className="flex w-full flex-wrap items-baseline gap-2 text-ui-xs"
    >
      <span className="text-destructive">
        {sandboxVerbFailureLine(
          operation.verb,
          props.name,
          operation.reference,
        )}
      </span>
      <Button
        type="button"
        variant="link"
        size="inline-xs"
        disabled={props.busy}
        onClick={() => props.onRetry(operation.verb)}
      >
        {RETRY}
      </Button>
      <Button
        type="button"
        variant="link"
        size="inline-xs"
        onClick={() => openSandboxDetails(props.sandboxId)}
      >
        {DETAILS}
      </Button>
    </div>
  );
}
