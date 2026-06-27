import { Check, Copy } from "lucide-react";
import { useCallback } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";

const COPIED_RESET_MS = 1600;

interface CopyTextButtonProps {
  readonly value: string;
  /** Visible label, or `null` to render an icon-only button. */
  readonly label: string | null;
  readonly ariaLabel: string;
  readonly disabled: boolean;
}

/**
 * Copies `value` to the clipboard and briefly confirms with a check. With a
 * `label` it renders an outline button (icon + text) sized to sit next to other
 * `size="sm"` actions; with `label: null` it renders a compact icon-only
 * button. Reuses {@link useClipboardCopy}, so an insecure-context clipboard
 * failure surfaces a toast.
 */
export function CopyTextButton(props: CopyTextButtonProps) {
  const { value, label, ariaLabel, disabled } = props;
  const { copied, copy } = useClipboardCopy({
    resetMs: COPIED_RESET_MS,
    onSuccess: null,
    onError: () => toast.error("Couldn't copy to clipboard."),
  });
  const handleCopy = useCallback(() => copy(value), [copy, value]);
  const Icon = copied ? Check : Copy;

  if (label === null) {
    return (
      <button
        type="button"
        onClick={handleCopy}
        disabled={disabled}
        aria-label={copied ? "Copied" : ariaLabel}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/80 transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
      >
        <Icon className="size-3.5" aria-hidden />
      </button>
    );
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="shrink-0"
      disabled={disabled}
      aria-label={copied ? "Copied" : ariaLabel}
      onClick={handleCopy}
    >
      <Icon />
      {copied ? "Copied" : label}
    </Button>
  );
}
