import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { XIcon } from "lucide-react";
import { usePaneAwareContentGuard } from "@/components/epic-tabs/pane-visibility-context";
import { usePortalConcealed } from "@/components/ui/portal-concealment-context";

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
}) {
  // Dialog roots retain their logical open state so operation/staging state
  // survives split focus changes. A modal dialog kept mounted in the background
  // would keep aria-hiding + scroll-locking the focused split partner, so an
  // unfocused pane un-presents by unmounting only its document portal. That
  // The close-autofocus half lives in `usePaneAwareContentGuard`.
  const { paneFocused, handleCloseAutoFocus } =
    usePaneAwareContentGuard(onCloseAutoFocus);
  // A concealed region's dialog un-presents the same way an unfocused pane's
  // does: a portal's DOM escapes the region's own concealment (see
  // `portal-concealment-context`), so the portal unmounts while the root
  // keeps its open state and the owner keeps any staged form state, ready to
  // re-present when the region returns.
  const concealed = usePortalConcealed();
  if (!paneFocused || concealed) return null;
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        data-browser-overlay="dialog"
        className={cn(
          // `top-safe-center-y` / `left-safe-center-x`, not `top-1/2` /
          // `left-1/2`: a fixed element centres on the viewport, which on a
          // phone includes the strips the app never paints into - the status
          // bar above, and the sensor housing on one side in landscape. Both
          // collapse to the halfway marks wherever the insets are zero.
          //
          // `max-w-safe-dvw` caps the width against the same region. It is
          // unmodified so a caller's `sm:max-w-*` still wins at width; a caller
          // that sets an UNMODIFIED `max-w-*` displaces it, which is what the
          // contract test watches for.
          "fixed top-safe-center-y left-safe-center-x z-50 grid w-full max-w-[min(calc(100%-2rem),var(--safe-area-width))] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-ui-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className,
        )}
        onCloseAutoFocus={handleCloseAutoFocus}
        {...props}
      >
        {children}
        {showCloseButton ? (
          <DialogPrimitive.Close data-slot="dialog-close" asChild>
            <Button
              variant="ghost"
              className="absolute top-2 right-2"
              size="icon-sm"
            >
              <XIcon />
              <span className="sr-only">Close</span>
            </Button>
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        // `bg-foreground/5`, not `bg-muted/50`: the footer band renders on
        // `DialogContent`'s own `bg-popover`, and every preset dark theme
        // defines `--muted` equal to `--popover`, so the band used to
        // disappear in all of them and leave only `border-t`. See
        // `ui/skeleton.tsx` for the token collapse in full.
        "-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-foreground/5 p-4 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton ? (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      ) : null}
    </div>
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("font-heading text-ui leading-none font-medium", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "max-w-[72ch] text-ui-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
