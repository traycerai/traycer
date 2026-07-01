import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { cn } from "@/lib/utils";
import { COPY_CONFIRMATION_RESET_MS } from "./styles";

const handleCopyError = (): void => {
  toast.error("Couldn't copy to clipboard.");
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
      <span
        className={cn(
          "font-mono text-overline uppercase",
          props.isHero ? "text-white/[0.55]" : "text-muted-foreground",
        )}
      >
        {props.label}
      </span>
      <div
        className={cn(
          "flex min-w-0 items-center rounded-md border transition-colors",
          props.isHero
            ? "border-white/[0.14] bg-black/[0.16] focus-within:border-white/[0.45]"
            : "border-border bg-background focus-within:border-ring",
        )}
      >
        <span
          className={cn(
            "min-w-0 flex-1 px-3 py-2 text-left font-mono font-semibold",
            props.valueKind === "code"
              ? "tracking-widest"
              : "truncate tracking-normal",
            props.isHero ? "text-white" : "text-foreground",
          )}
          title={props.value}
          data-testid={props.testId}
        >
          {props.value}
        </span>
        <button
          type="button"
          onClick={() => copy(props.value)}
          aria-label={copied ? "Copied" : props.copyLabel}
          className={cn(
            "mr-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:ring-1 focus-visible:outline-none",
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
      <span
        className={cn(
          "min-h-4 text-ui-xs",
          copied ? "opacity-100" : "opacity-0",
          props.isHero ? "text-white/[0.62]" : "text-muted-foreground",
        )}
        aria-live="polite"
      >
        {copied ? "Copied" : ""}
      </span>
    </div>
  );
}
