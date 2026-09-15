import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { cn } from "@/lib/utils";

export interface WelcomeModalFooterAction {
  readonly label: string;
  readonly onSelect: () => void;
}

export interface WelcomeModalFooterPrimary extends WelcomeModalFooterAction {
  readonly disabled: boolean;
  readonly pending: boolean;
}

/**
 * The band every welcome page ends in: optional context on the left (page 2
 * puts its scan-window picker and selection count there), one optional
 * secondary action, one primary. Pending keeps the label and adds the
 * spinner inline (gui-app AGENTS.md), so "Import 9 tasks" never turns into
 * "Importing…" under the user's cursor.
 *
 * `bg-foreground/5`, not `bg-muted`: the band renders on `DialogContent`'s
 * `bg-popover`, and every preset dark theme collapses `--muted` into it.
 */
export function WelcomeModalFooter(props: {
  readonly leading: ReactNode | null;
  readonly secondary: WelcomeModalFooterAction | null;
  readonly primary: WelcomeModalFooterPrimary;
}): ReactNode {
  const { leading, secondary, primary } = props;
  return (
    <div
      data-testid="welcome-modal-footer"
      className={cn(
        "flex shrink-0 items-center gap-2 border-t border-border/60 bg-foreground/5 px-6 py-3.5",
        leading === null ? "justify-end" : "justify-between",
      )}
    >
      {leading !== null ? (
        <div className="flex min-w-0 items-center gap-2">{leading}</div>
      ) : null}
      <div className="flex shrink-0 items-center gap-2">
        {secondary !== null ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={secondary.onSelect}
          >
            {secondary.label}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          disabled={primary.disabled || primary.pending}
          onClick={primary.onSelect}
        >
          {primary.pending ? <MutedAgentSpinner /> : null}
          {primary.label}
        </Button>
      </div>
    </div>
  );
}
