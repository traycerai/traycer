import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  SCROLL_MORE_BELOW_FADE_CLASS,
  useScrollMoreBelow,
} from "@/hooks/ui/use-scroll-more-below";
import type { SandboxKind } from "@/lib/sandbox/bridge-host";
import { cn } from "@/lib/utils";

interface SandboxLinkConfirmProps {
  /** The link a page asked to open, or `null` when nothing is asked. */
  readonly url: string | null;
  /** What asked: the line names an app as an app, anything else as a page. */
  readonly kind: SandboxKind;
  /** The asking app's server, named in the line; `null` for a page. */
  readonly appName: string | null;
  readonly onDecide: (open: boolean) => void;
}

function linkAsker(kind: SandboxKind, appName: string | null): string {
  if (kind !== "app") return "The page";
  return appName === null ? "The app" : `The ${appName} app`;
}

/**
 * The app's own confirm for a link an agent page, wireframe or MCP App asked
 * to open (D42). The page cannot prove the reader clicked inside it, so the
 * reader sees the whole URL and decides here, outside the page's reach.
 * Cancel comes first, so it is what the dialog focuses; Esc cancels too.
 */
export function SandboxLinkConfirm(props: SandboxLinkConfirmProps) {
  const { url, kind, appName, onDecide } = props;
  const [urlBox, setUrlBox] = useState<HTMLParagraphElement | null>(null);
  const moreBelow = useScrollMoreBelow(urlBox);
  return (
    <Dialog
      open={url !== null}
      onOpenChange={(open) => {
        if (!open) onDecide(false);
      }}
    >
      <DialogContent
        layout="banded"
        // Never taller than the safe viewport: the URL scrolls, the actions
        // stay in view however long it is (the bridge caps it at 8 KiB).
        className="flex max-h-[calc(var(--spacing-safe-dvh)-2rem)] w-full min-w-0 flex-col overflow-hidden sm:max-w-md"
        showCloseButton={false}
      >
        <DialogHeader className="shrink-0 space-y-1">
          <DialogTitle>Open this link?</DialogTitle>
          <DialogDescription className="break-words">
            {linkAsker(kind, appName)} wants to open:
          </DialogDescription>
        </DialogHeader>
        <p
          ref={setUrlBox}
          data-testid="sandbox-link-url"
          data-more-below={moreBelow}
          className={cn(
            "max-h-[40svh] min-h-0 overflow-y-auto px-5 py-3 font-mono text-ui-sm break-all text-foreground",
            moreBelow && SCROLL_MORE_BELOW_FADE_CLASS,
          )}
        >
          {url}
        </p>
        <DialogFooter className="shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onDecide(false)}
          >
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={() => onDecide(true)}>
            Open
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
