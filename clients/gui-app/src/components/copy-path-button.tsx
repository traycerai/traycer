import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";

import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
/**
 * Shared inline copy action for file paths and workspace folder paths.
 *
 * Icon-only control: it carries a >=3:1 default-state cue (WCAG 2.2 non-text
 * contrast) via `text-muted-foreground` with no opacity attenuation, not just
 * on hover/focus.
 */
export function CopyPathButton(props: {
  readonly path: string;
  readonly appearance?: "default" | "tooltip";
  readonly ariaLabel: string;
  readonly testId: string;
}) {
  const { copied, copy } = useClipboardCopy({
    resetMs: 1500,
    onSuccess: null,
    onError: null,
  });
  const label = copied ? "Copied" : "Copy path";
  return (
    <TooltipWrapper
      label={props.appearance === "tooltip" ? undefined : label}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <button
        type="button"
        aria-label={copied ? "Copied" : props.ariaLabel}
        data-testid={props.testId}
        onClick={(event) => {
          event.stopPropagation();
          copy(props.path);
        }}
        className={cn(
          "inline-flex size-5 shrink-0 items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-2",
          props.appearance === "tooltip"
            ? "text-current hover:bg-background/10 focus-visible:ring-current"
            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:ring-ring/60",
        )}
      >
        {copied ? (
          <Check className="size-3.5" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </button>
    </TooltipWrapper>
  );
}
