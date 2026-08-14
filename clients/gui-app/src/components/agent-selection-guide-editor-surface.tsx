import type { ReactNode } from "react";
import { MarkdownEditPreview } from "@/components/markdown-edit-preview";
import { Button } from "@/components/ui/button";
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
  readonly editorClassName: string;
  readonly className: string;
  readonly revertDisabled: boolean;
  readonly onRevert: () => void;
  readonly revertTestId: string | undefined;
  readonly status: ReactNode;
};

export function AgentSelectionGuideEditorSurface({
  titleId,
  value,
  onValueChange,
  onBlur,
  disabled,
  placeholder,
  ariaLabel,
  testId,
  editorClassName,
  className,
  revertDisabled,
  onRevert,
  revertTestId,
  status,
}: AgentSelectionGuideEditorSurfaceProps) {
  return (
    <section
      aria-labelledby={titleId}
      className={cn("flex min-h-0 flex-col gap-3", className)}
    >
      <div className="min-w-0">
        <h2 id={titleId} className="text-ui-md font-semibold text-foreground">
          {AGENT_SELECTION_GUIDE_TITLE}
        </h2>
        <p className="mt-1 text-ui-xs text-muted-foreground">
          {AGENT_SELECTION_GUIDE_DESCRIPTION}
        </p>
      </div>

      <div
        data-agent-selection-guide-editor-shell=""
        aria-disabled={disabled}
        className={cn(
          "relative flex min-h-0 flex-col overflow-hidden rounded-md border border-input bg-background shadow-xs transition-[color,box-shadow]",
          "focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
          disabled && "cursor-not-allowed opacity-50",
          editorClassName,
        )}
        onBlur={onBlur ?? undefined}
      >
        <MarkdownEditPreview
          value={value}
          onChange={onValueChange}
          readOnly={disabled}
          placeholder={placeholder}
          ariaLabel={ariaLabel}
          testId={testId}
          showPreview
        />
      </div>

      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={revertDisabled}
          onClick={onRevert}
          data-testid={revertTestId}
          className="h-7 px-2"
        >
          Revert to default
        </Button>
        {status}
      </div>
    </section>
  );
}
