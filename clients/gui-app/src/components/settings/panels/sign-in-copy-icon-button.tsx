import { Check, Copy } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { handleSignInLinkCopyError } from "./provider-sign-in-link";

const SIGN_IN_COPY_RESET_MS = 1600;

/**
 * One sign-in value's copy control. The device code and the approval link
 * each keep their own tick.
 */
export function SignInCopyIconButton(props: {
  readonly value: string;
  readonly kind: "code" | "link";
  readonly variant: "outline" | "ghost";
}): ReactNode {
  const { copied, copy } = useClipboardCopy({
    resetMs: SIGN_IN_COPY_RESET_MS,
    onSuccess: null,
    onError: handleSignInLinkCopyError,
  });
  const idleLabel =
    props.kind === "code" ? "Copy sign-in code" : "Copy sign-in link";
  const copiedLabel =
    props.kind === "code" ? "Copied sign-in code" : "Copied sign-in link";
  return (
    <Button
      type="button"
      size="icon-sm"
      variant={props.variant}
      aria-label={copied ? copiedLabel : idleLabel}
      onClick={() => copy(props.value)}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </Button>
  );
}
