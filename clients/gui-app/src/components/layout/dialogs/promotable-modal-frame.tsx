import { type ComponentProps, type RefObject, type ReactNode } from "react";
import { SquareArrowOutUpRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DialogPopup,
  DialogBackdrop,
  DialogPortal,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";

interface PromotableModalFrameProps {
  readonly icon: ReactNode;
  readonly title: string;
  /** Sizing for the centered frame (the rest of the chrome is shared). */
  readonly contentClassName: string;
  /** Extra `data-*` attributes spread onto the content (debug/test hooks). */
  readonly dataAttributes: Record<string, string>;
  readonly promoteAriaLabel: string;
  readonly promoteTestId: string;
  readonly closeTestId: string;
  readonly onPromote: () => void;
  readonly onClose: () => void;
  readonly initialFocus: ComponentProps<typeof DialogPopup>["initialFocus"];
  readonly backdropRef: RefObject<HTMLDivElement | null>;
  readonly children: ReactNode;
}

/**
 * Shared floating-modal chrome for surfaces that can be promoted into a tab
 * (Settings/History, Workspaces): dimmed overlay, centered frame, and a title
 * bar with "Open as tab" + Close. Callers supply the sizing and body so the
 * modal reads as the same surface as its tab-mounted variant, just framed.
 *
 * Render inside a `<Dialog>` whose open state the caller owns.
 */
export function PromotableModalFrame({
  backdropRef,
  ...props
}: PromotableModalFrameProps): ReactNode {
  return (
    <DialogPortal>
      <DialogBackdrop
        ref={backdropRef}
        data-slot="dialog-overlay"
        variant="frame"
      />
      <DialogPopup
        data-slot="dialog-content"
        aria-describedby={undefined}
        variant="frame"
        className={props.contentClassName}
        initialFocus={props.initialFocus}
        {...props.dataAttributes}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-secondary px-4 py-2">
          {props.icon}
          <DialogTitle data-slot="dialog-title" appearance="host">
            {props.title}
          </DialogTitle>
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
            <DialogClose
              render={
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
              }
            />
          </div>
        </header>
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {props.children}
        </div>
      </DialogPopup>
    </DialogPortal>
  );
}
