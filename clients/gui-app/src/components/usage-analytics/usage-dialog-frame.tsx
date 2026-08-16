import type { ReactNode } from "react";
import { LineChart } from "lucide-react";
import {
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * Phone tier (viewport < 28rem): the centered dialog becomes a bottom
 * sheet. Viewport-keyed (`max-[28rem]:`) deliberately, unlike the content
 * folds inside the body, which key on the dialog's own container width -
 * whether the frame is a sheet is a property of the screen, not of the
 * dialog's width. Tailwind emits variant rules after base utilities, so
 * these override the primitive's centered positioning without
 * `!important`. Heights stay dialog-owned: the epic dialog adds
 * `max-[28rem]:h-[94dvh]`; the chat dialog keeps its shorter fixed height.
 */
export const USAGE_DIALOG_SHEET_CLASSES =
  "max-[28rem]:top-auto max-[28rem]:bottom-0 max-[28rem]:left-0 max-[28rem]:translate-x-0 max-[28rem]:translate-y-0 max-[28rem]:w-screen max-[28rem]:max-w-none max-[28rem]:rounded-b-none";

export interface UsageDialogFrameProps {
  readonly title: ReactNode;
  readonly description: ReactNode;
  /** Trailing header controls (the epic dialog's window picker) - `null` when the dialog has none. */
  readonly headerControls: ReactNode;
  /** Pinned footer content - `null` when the dialog has no footer (the chat scope has no Settings destination). */
  readonly footer: ReactNode;
  readonly children: ReactNode;
}

/**
 * The usage dialogs' shared fixed-frame scaffold, mounted inside a
 * fixed-`h` `DialogContent`: pinned header row (icon ring + title +
 * trailing controls), scrollable body, optional pinned footer. The frame
 * renders unconditionally around every body state - loading, error, empty,
 * loaded - which is the whole "no jump" guarantee: states swap inside a
 * constant frame instead of resizing it.
 *
 * The body is the `@container` the content folds key on, and it reserves a
 * stable scrollbar gutter so a classic (non-overlay) scrollbar can't
 * shrink the container's inline size and fire a fold early.
 */
export function UsageDialogFrame(props: UsageDialogFrameProps): ReactNode {
  return (
    <>
      {/* Sheet affordance only - X and scrim-tap remain the dismissals. */}
      <div
        aria-hidden
        className="mx-auto hidden h-1 w-9 shrink-0 rounded-full bg-muted-foreground/25 max-[28rem]:block"
      />
      {/* `pr-8` clears the primitive's absolutely-positioned close button
          (`top-2 right-2`) so inline header controls never land under it. */}
      <div className="flex min-w-0 items-start gap-3 pr-8 max-[28rem]:flex-col">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary ring-1 ring-primary/15">
            <LineChart className="size-4" aria-hidden />
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <DialogTitle className="truncate text-ui font-semibold leading-snug wrap-anywhere">
              {props.title}
            </DialogTitle>
            <DialogDescription>{props.description}</DialogDescription>
          </div>
        </div>
        {props.headerControls === null ? null : (
          <div className="shrink-0">{props.headerControls}</div>
        )}
      </div>
      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable] @container",
          // The footer normally absorbs the home-indicator inset for the
          // whole sheet. Without one (the chat dialog) the body is what
          // reaches `bottom-0`, so it has to absorb it instead - otherwise
          // an expanded turn drilldown scrolls its last rows under the
          // indicator. Additive on top of the content's own padding, and
          // exactly `0` wherever the inset is.
          props.footer === null &&
            "max-[28rem]:pb-[env(safe-area-inset-bottom)]",
        )}
        data-testid="usage-dialog-body"
      >
        {props.children}
      </div>
      {props.footer === null ? null : (
        // The band fill is the primitive's own default - restating it here
        // would just be a second copy to keep in sync.
        <DialogFooter className="-mx-4 -mb-4 mt-0 border-t px-4 py-3 max-[28rem]:rounded-b-none max-[28rem]:pb-[max(env(safe-area-inset-bottom),0.75rem)]">
          {props.footer}
        </DialogFooter>
      )}
    </>
  );
}
