import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";

/** Reserves its own row so the transcript never sits under the control. */
export function BotUnreadBanner(props: {
  readonly label: string;
  readonly navigateTestId: string | undefined;
  readonly onNavigate: () => void;
  readonly onMarkRead: () => void;
  readonly pending: boolean;
  readonly failed: boolean;
}): ReactNode {
  return (
    <div
      data-testid="bot-unread-banner"
      className="flex shrink-0 flex-col items-center gap-1 py-2"
    >
      <div className="flex max-w-full items-center rounded-full border bg-popover text-popover-foreground shadow-sm">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid={props.navigateTestId}
          onClick={props.onNavigate}
        >
          {props.label}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm-touch"
          aria-label="Mark all read"
          disabled={props.pending}
          onClick={props.onMarkRead}
        >
          {props.pending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : (
            <X aria-hidden="true" />
          )}
        </Button>
      </div>
      {props.failed ? (
        <p role="alert" className="text-ui-sm text-muted-foreground">
          Couldn't mark these messages read. Try again.
        </p>
      ) : null}
    </div>
  );
}
