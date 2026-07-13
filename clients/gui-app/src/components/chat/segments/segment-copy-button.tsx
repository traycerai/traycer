import { Check, Copy } from "lucide-react";
import { useCallback } from "react";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { cn } from "@/lib/utils";
import { reportableErrorToast } from "@/lib/reportable-error-toast";

interface SegmentCopyButtonProps {
  value: string;
  ariaLabel: string;
  className: string | undefined;
}

const COPIED_RESET_MS = 1600;

const handleCopyError = (): void => {
  reportableErrorToast("Couldn't copy to clipboard.", undefined, {
    title: "Could not copy to clipboard",
    message: null,
    code: null,
    source: "Clipboard",
  });
};

/**
 * Hover-revealed copy button used inside expanded segment panels. Falls back
 * to a sonner toast on clipboard rejection so the user always sees feedback.
 */
export function SegmentCopyButton(props: SegmentCopyButtonProps) {
  const { value, ariaLabel, className } = props;
  const { copied, copy } = useClipboardCopy({
    resetMs: COPIED_RESET_MS,
    onSuccess: null,
    onError: handleCopyError,
  });
  const handleCopy = useCallback(() => copy(value), [copy, value]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? "Copied" : ariaLabel}
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-md",
        "text-muted-foreground/70 transition-colors",
        "opacity-0 group-hover/segment-panel:opacity-100 focus-visible:opacity-100",
        "hover:bg-accent hover:text-foreground",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
        className,
      )}
    >
      {copied ? (
        <Check className="size-3.5" aria-hidden />
      ) : (
        <Copy className="size-3.5" aria-hidden />
      )}
    </button>
  );
}
