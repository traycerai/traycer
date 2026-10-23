import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * A bot read that failed, said in place with a way to ask again. The caller
 * places it; it carries no margin of its own.
 */
export function BotReadFailure(props: {
  readonly message: string;
  readonly onRetry: () => void;
  readonly testId: string;
}): ReactNode {
  return (
    <div
      role="status"
      data-testid={props.testId}
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-ui-sm text-destructive"
    >
      <span>{props.message}</span>
      <Button type="button" variant="outline" size="sm" onClick={props.onRetry}>
        Retry
      </Button>
    </div>
  );
}
