import { Check, Copy } from "lucide-react";
import { useCallback, type ReactNode } from "react";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { cn } from "@/lib/utils";
import { reportableErrorToast } from "@/lib/reportable-error-toast";

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
 * Floating copy affordance pinned to the top-right corner of an A2A
 * send/received message body, mirroring `OpenFullDiffControl`'s always-visible
 * corner placement over the artifact diff viewer. Absolutely positioned over
 * the scrollable message box (which carries `pr-10` so text clears it); the
 * box keeps its own border and native scrollbar, so the scrollbar stays flush
 * against that border rather than being pushed inward by a reserved gutter.
 */
export function AgentMessageCopyButton(props: {
  readonly value: string;
}): ReactNode {
  const { value } = props;
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
      aria-label={copied ? "Copied" : "Copy message"}
      title={copied ? "Copied" : "Copy message"}
      className={cn(
        "absolute top-2 right-2 z-10 flex size-7 items-center justify-center",
        "cursor-pointer rounded-md border border-border bg-muted text-muted-foreground shadow-md",
        "transition-colors hover:bg-accent hover:text-foreground",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
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
