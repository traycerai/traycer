import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
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
  readonly revertLabel: string;
  readonly revertIcon: ReactNode;
  readonly revertTooltip: string | null;
  readonly onRevert: () => void;
  readonly revertTestId: string | undefined;
  readonly status: ReactNode;
};

export function AgentSelectionGuideEditorSurface(
  props: AgentSelectionGuideEditorSurfaceProps,
) {
  const revertButton = (
    <RevertButton
      disabled={props.revertDisabled}
      icon={props.revertIcon}
      label={props.revertLabel}
      onClick={props.onRevert}
      testId={props.revertTestId}
      tooltip={props.revertTooltip}
    />
  );
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
        <WorkspaceGuideHint className="mt-2" />
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
        <div className="flex min-w-0 flex-1 items-center justify-start">
          {revertButton}
        </div>
        <div className="flex shrink-0 items-center gap-3">{props.status}</div>
      </div>
    </section>
  );
}

function WorkspaceGuideHint(props: { readonly className: string }) {
  return (
    <p className={cn("text-ui-xs text-muted-foreground", props.className)}>
      For workspace-specific instructions, add a{" "}
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.95em]">
        .traycer/agent-selection-guide.md
      </code>{" "}
      file in a workspace. It layers on top of these global instructions.
    </p>
  );
}

function RevertButton(props: {
  readonly disabled: boolean;
  readonly icon: ReactNode;
  readonly label: string;
  readonly onClick: () => void;
  readonly testId: string | undefined;
  readonly tooltip: string | null;
}) {
  return (
    <TooltipWrapper
      label={props.tooltip}
      side="top"
      sideOffset={6}
      align="start"
    >
      <span className="inline-flex">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={props.disabled}
          onClick={props.onClick}
          data-testid={props.testId}
          className="h-7 px-2"
        >
          {props.icon}
          {props.label}
        </Button>
      </span>
    </TooltipWrapper>
  );
}
