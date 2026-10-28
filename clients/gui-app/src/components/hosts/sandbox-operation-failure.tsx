import type { ReactNode } from "react";
import {
  useSandboxOperationFailure,
  type SandboxOperationFailureProps,
} from "@/hooks/sandboxes/use-sandbox-operation-failure";

/** Mount runtime-dependent remedies only when a row has a failure. */
export function SandboxOperationFailure(
  props: SandboxOperationFailureProps,
): ReactNode {
  if (props.operation?.kind === "skipped") {
    return (
      <p role="status" className="w-full text-ui-xs text-muted-foreground">
        Skipped {props.name} · {props.operation.message}
      </p>
    );
  }
  if (props.operation?.kind !== "failed") return null;
  return <SandboxOperationFailureContent {...props} />;
}

function SandboxOperationFailureContent(
  props: SandboxOperationFailureProps,
): ReactNode {
  return useSandboxOperationFailure(props);
}
