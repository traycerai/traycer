import type { ReactNode } from "react";
import type { StagedSandbox } from "@/stores/composer/staged-sandbox-store";
import { SandboxOperationFailure } from "@/components/hosts/sandbox-operation-failure";
import { useSandboxOperation } from "@/hooks/sandboxes/use-sandbox-operation";

export function StagedStopFailure(props: {
  readonly stage: StagedSandbox;
  readonly fallbackName: string;
  readonly onRetry: () => void;
}): ReactNode {
  const { stage } = props;
  const sandboxId = stage.createdSandboxId ?? "";
  const operation = useSandboxOperation(sandboxId);
  return (
    <SandboxOperationFailure
      sandboxId={sandboxId}
      name={
        stage.target.name.length > 0 ? stage.target.name : props.fallbackName
      }
      configuration={stage.target.configuration}
      operation={operation?.verb === "stop" ? operation : null}
      busy={operation?.kind === "pending"}
      onRetry={props.onRetry}
    />
  );
}
