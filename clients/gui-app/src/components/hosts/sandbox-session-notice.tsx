import type { ReactNode } from "react";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import { sandboxSessionNotice } from "@/components/hosts/sandbox-card-model";
import { useSampledNow } from "@/lib/relative-time";

export function SandboxSessionNotice(props: {
  readonly summary: SandboxSummary;
  readonly filesOutcomeStated: boolean;
  readonly testId: string;
}): ReactNode {
  const now = useSampledNow();
  const line = sandboxSessionNotice(
    props.summary,
    now,
    props.filesOutcomeStated,
  );
  return line === null ? null : (
    <p
      className="text-ui-xs text-warning-foreground"
      data-testid={props.testId}
    >
      {line}
    </p>
  );
}
