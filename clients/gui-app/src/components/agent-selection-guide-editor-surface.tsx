import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export const AGENT_SELECTION_GUIDE_TITLE = "Agent selection guide";
export const AGENT_SELECTION_GUIDE_DESCRIPTION =
  "Instructions for how Traycer agents choose child-agent harnesses, models, and reasoning effort.";

type AgentSelectionGuideEditorSurfaceProps = {
  readonly titleId: string;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly onBlur: (() => void) | null;
  readonly disabled: boolean;
  readonly placeholder: string | undefined;
  readonly ariaLabel: string;
  readonly testId: string;
  readonly textareaClassName: string;
  readonly className: string;
  readonly revertDisabled: boolean;
  readonly onRevert: () => void;
  readonly revertTestId: string | undefined;
  readonly status: ReactNode;
};

export function AgentSelectionGuideEditorSurface(
  props: AgentSelectionGuideEditorSurfaceProps,
) {
  return (
    <section
      aria-labelledby={props.titleId}
      className={cn("flex min-h-0 flex-col gap-3", props.className)}
    >
      <div className="min-w-0">
        <h2
          id={props.titleId}
          className="text-ui-md font-semibold text-foreground"
        >
          {AGENT_SELECTION_GUIDE_TITLE}
        </h2>
        <p className="mt-1 text-ui-xs text-muted-foreground">
          {AGENT_SELECTION_GUIDE_DESCRIPTION}
        </p>
      </div>

      <Textarea
        value={props.value}
        onChange={(event) => props.onValueChange(event.target.value)}
        onBlur={props.onBlur ?? undefined}
        spellCheck={false}
        disabled={props.disabled}
        aria-label={props.ariaLabel}
        data-testid={props.testId}
        placeholder={props.placeholder}
        className={cn(
          "min-h-0 overflow-y-auto font-mono text-code-xs leading-relaxed",
          props.textareaClassName,
        )}
      />

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <p className="min-w-[min(100%,18rem)] flex-1 text-ui-xs text-muted-foreground">
          For workspace-specific instructions, add a{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.95em]">
            .traycer/agent-selection-guide.md
          </code>{" "}
          file in a workspace. It layers on top of these global instructions.
        </p>
        <div className="flex shrink-0 items-center gap-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={props.revertDisabled}
            onClick={props.onRevert}
            data-testid={props.revertTestId}
            className="h-7 px-2"
          >
            Revert to default
          </Button>
          {props.status}
        </div>
      </div>
    </section>
  );
}
