import { useRef, type ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { SquareArrowOutUpRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  dialogContentInertToPointer,
  interactionStartedOnOverlay,
} from "@/components/layout/dialogs/dialog-outside-guard";

interface PromotableModalFrameProps {
  readonly icon: ReactNode;
  readonly title: string;
  readonly contentClassName: string;
  readonly dataAttributes: Record<string, string>;
  readonly promoteAriaLabel: string;
  readonly promoteTestId: string;
  readonly closeTestId: string;
  readonly onPromote: () => void;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

// `top-safe-center-y` / `left-safe-center-x`, not the halfway marks: a fixed frame centres on the viewport,
// which on a phone includes the strips the app never paints into.
const FRAME_CONTENT_CLASS =
  "fixed top-safe-center-y left-safe-center-x z-50 flex max-w-safe-dvw -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl bg-background text-foreground ring-1 ring-foreground/10 shadow-2xl duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";

/** Shared floating-modal chrome for surfaces that can be promoted into a tab (Settings/History, Workspaces):
 * dimmed overlay, centered frame, and a title bar with "Open as tab" + Close. */
export function PromotableModalFrame(
  props: PromotableModalFrameProps,
): ReactNode {
  const overlayRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Only this pointerdown-time sample can tell "dismissing the dropdown" apart from a genuine backdrop click;
  // see dialog-outside-guard.ts.
  const nestedLayerOwnedPointerDownRef = useRef(false);
  // A genuine backdrop click still closes the modal; any outside-dismissal whose gesture did not start on the
  // overlay, or started while a nested layer held the pointer, is left to that inner layer.
  const preventUnlessGenuineBackdropGesture = (event: {
    readonly detail: { readonly originalEvent: Event };
    readonly preventDefault: () => void;
  }): void => {
    if (
      nestedLayerOwnedPointerDownRef.current ||
      !interactionStartedOnOverlay(
        event.detail.originalEvent,
        overlayRef.current,
      )
    ) {
      event.preventDefault();
    }
  };
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        ref={overlayRef}
        data-slot="dialog-overlay"
        className="fixed inset-0 isolate z-50 bg-black/30 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
        onPointerDown={() => {
          nestedLayerOwnedPointerDownRef.current = dialogContentInertToPointer(
            contentRef.current,
          );
        }}
      />
      <DialogPrimitive.Content
        ref={contentRef}
        data-slot="dialog-content"
        aria-describedby={undefined}
        className={cn(FRAME_CONTENT_CLASS, props.contentClassName)}
        onPointerDownOutside={preventUnlessGenuineBackdropGesture}
        onInteractOutside={preventUnlessGenuineBackdropGesture}
        {...props.dataAttributes}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-secondary px-4 py-2">
          {props.icon}
          <DialogPrimitive.Title
            data-slot="dialog-title"
            className="font-heading text-ui leading-none font-medium"
          >
            {props.title}
          </DialogPrimitive.Title>
          <div className="ml-auto flex items-center gap-1">
            {/* No promote on phones: the strip-tab surface it opens isn't
                mobile-ready, and below md the modal is already full-screen. */}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="max-md:hidden"
              aria-label={props.promoteAriaLabel}
              data-testid={props.promoteTestId}
              onClick={props.onPromote}
            >
              <SquareArrowOutUpRight />
            </Button>
            <DialogPrimitive.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Close"
                data-testid={props.closeTestId}
                onClick={props.onClose}
              >
                <X />
              </Button>
            </DialogPrimitive.Close>
          </div>
        </header>
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {props.children}
        </div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
