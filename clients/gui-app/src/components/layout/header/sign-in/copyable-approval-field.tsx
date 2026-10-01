import { Check, Copy } from "lucide-react";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { cn } from "@/lib/utils";
import { COPY_CONFIRMATION_RESET_MS } from "./styles";
import { reportableErrorToast } from "@/lib/reportable-error-toast";

import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
const handleCopyError = (): void => {
  reportableErrorToast("Couldn't copy to clipboard.", undefined, {
    title: "Could not copy to clipboard",
    message: null,
    code: null,
    source: "Sign in",
  });
};

export function CopyableApprovalField(props: {
  readonly label: string;
  readonly value: string;
  readonly copyLabel: string;
  readonly testId: string;
  readonly isHero: boolean;
  readonly valueKind: "code" | "url";
}) {
  const { copied, copy } = useClipboardCopy({
    resetMs: COPY_CONFIRMATION_RESET_MS,
    onSuccess: null,
    onError: handleCopyError,
  });

  return (
    <div className="grid gap-1.5">
      {/* "Copied" shares the label's line, so it holds no room under the field. */}
      <div
        className={cn(
          "flex items-baseline justify-between gap-2 text-overline",
          props.isHero ? "text-white/[0.55]" : "text-muted-foreground",
        )}
      >
        <span className="font-mono uppercase">{props.label}</span>
        <span
          className={cn(
            "font-normal",
            copied ? "opacity-100" : "opacity-0",
            props.isHero ? "text-white/[0.62]" : null,
          )}
          aria-live="polite"
        >
          {copied ? "Copied" : ""}
        </span>
      </div>
      <div
        className={cn(
          "flex min-w-0 items-center rounded-md border transition-colors",
          props.isHero
            ? "border-white/[0.14] bg-black/[0.16] focus-within:border-white/[0.45]"
            : "border-border bg-background focus-within:border-ring",
        )}
      >
        <TooltipWrapper
          label={props.value}
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <span
            className={cn(
              "min-w-0 flex-1 px-3 py-2 text-left font-mono font-semibold @max-[15rem]/signin:px-2",
              // The code is one token: never broken, never cut. A narrow panel
              // (the strip at its narrowest) steps it down to fit.
              props.valueKind === "code"
                ? "whitespace-nowrap tracking-widest @max-[13rem]/signin:text-ui-xs @max-[13rem]/signin:tracking-normal"
                : "truncate tracking-normal",
              props.isHero ? "text-white" : "text-foreground",
            )}
            data-testid={props.testId}
          >
            {props.value}
          </span>
        </TooltipWrapper>
        <button
          type="button"
          onClick={() => copy(props.value)}
          aria-label={copied ? "Copied" : props.copyLabel}
          className={cn(
            "mr-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:ring-1 focus-visible:outline-none @max-[15rem]/signin:mr-0.5 @max-[15rem]/signin:size-7",
            props.isHero
              ? "text-white/[0.58] hover:bg-white/10 hover:text-white focus-visible:ring-white/[0.55]"
              : "text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring",
          )}
        >
          {copied ? (
            <Check className="size-3.5" aria-hidden="true" />
          ) : (
            <Copy className="size-3.5" aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  );
}
