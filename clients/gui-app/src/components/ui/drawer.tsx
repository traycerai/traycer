import * as React from "react";
import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer";
import { useRender, type HTMLProps } from "@base-ui/react/use-render";

import { isToastEvent } from "@/components/ui/overlay-guards";
import { cn } from "@/lib/utils";

function Drawer({
  onOpenChange,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Root>) {
  return (
    <DrawerPrimitive.Root
      {...props}
      onOpenChange={(open, details) => {
        if (!open && isToastEvent(details)) details.cancel();
        else onOpenChange?.(open, details);
      }}
    />
  );
}

function DrawerTrigger({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Trigger>) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}

function DrawerPortal({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Portal>) {
  return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />;
}

function DrawerClose({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Close>) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

function DrawerOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Backdrop>) {
  return (
    <DrawerPrimitive.Backdrop
      data-slot="drawer-overlay"
      className={(state) =>
        cn(
          "fixed inset-0 z-50 bg-black/10 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
          typeof className === "function" ? className(state) : className,
        )
      }
      {...props}
      forceRender
    />
  );
}

function DrawerSurface({
  popupProps,
  state,
  render,
}: {
  popupProps: HTMLProps;
  state: DrawerPrimitive.Popup.State;
  render: React.ComponentProps<typeof DrawerPrimitive.Popup>["render"];
}) {
  const elementRef = React.useRef<HTMLElement>(null);
  React.useLayoutEffect(() => {
    if (!state.swiping) return;
    // Base has captured the current transform; the enter animation must yield it.
    for (const animation of elementRef.current?.getAnimations() ?? []) {
      if (
        animation instanceof CSSAnimation &&
        animation.animationName === "drawer-enter"
      ) {
        animation.cancel();
      }
    }
  }, [state.swiping]);
  return useRender({
    ref: elementRef,
    props: { ...popupProps },
    render:
      typeof render === "function" ? (props) => render(props, state) : render,
  });
}

/**
 * Base drawer primitive (drag-dismissable). Direction is caller-set via
 * `Drawer swipeDirection="down"`. The content imposes NO max-height itself so the
 * composing surface caps it with a viewport-aware value (e.g.
 * `max-h-[min(90dvh,…)]`) and owns its own internal scroll region. The grab
 * handle renders only for the bottom direction.
 */
function DrawerContent({
  ref,
  render,
  className,
  children,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Popup>) {
  return (
    <DrawerPortal data-slot="drawer-portal">
      <DrawerOverlay />
      <DrawerPrimitive.Viewport className="fixed inset-0 z-50">
        <DrawerPrimitive.Popup
          ref={ref}
          render={(popupProps, state) => (
            <DrawerSurface
              popupProps={popupProps}
              state={state}
              render={render}
            />
          )}
          data-slot="drawer-content"
          className={(state) =>
            cn(
              "group/drawer-content fixed z-50 flex h-auto flex-col bg-popover bg-clip-padding text-popover-foreground shadow-lg transform-none will-change-transform transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] data-swiping:transition-none data-open:animate-drawer-enter data-[swipe-direction=down]:[--drawer-enter-y:100%] data-[swipe-direction=down]:data-ending-style:translate-y-full data-[swipe-direction=up]:[--drawer-enter-y:-100%] data-[swipe-direction=up]:data-ending-style:-translate-y-full data-[swipe-direction=right]:[--drawer-enter-x:100%] data-[swipe-direction=right]:data-ending-style:translate-x-full data-[swipe-direction=left]:[--drawer-enter-x:-100%] data-[swipe-direction=left]:data-ending-style:-translate-x-full",
              "data-[swipe-direction=up]:inset-x-0 data-[swipe-direction=up]:top-0 data-[swipe-direction=up]:mb-24 data-[swipe-direction=up]:rounded-b-lg data-[swipe-direction=up]:border-b",
              "data-[swipe-direction=down]:inset-x-0 data-[swipe-direction=down]:bottom-0 data-[swipe-direction=down]:mt-24 data-[swipe-direction=down]:rounded-t-lg data-[swipe-direction=down]:border-t",
              "data-[swipe-direction=right]:inset-y-0 data-[swipe-direction=right]:right-0 data-[swipe-direction=right]:w-3/4 data-[swipe-direction=right]:border-l data-[swipe-direction=right]:sm:max-w-sm",
              "data-[swipe-direction=left]:inset-y-0 data-[swipe-direction=left]:left-0 data-[swipe-direction=left]:w-3/4 data-[swipe-direction=left]:border-r data-[swipe-direction=left]:sm:max-w-sm",
              // Safe-area inset, per direction, mirroring `sheet.tsx`: a drawer is
              // portalled and `fixed`, so `#root`'s padding never reaches it. The
              // horizontal insets apply to every direction, since the landscape
              // sensor housing sits on a side edge whichever way the drawer opens.
              // The edge a drawer is anchored to is left alone - it is meant to
              // meet the screen there, and pads its own contents instead.
              "data-[swipe-direction=up]:mt-safe-top data-[swipe-direction=up]:ml-safe-left data-[swipe-direction=up]:mr-safe-right",
              "data-[swipe-direction=down]:ml-safe-left data-[swipe-direction=down]:mr-safe-right",
              // The side directions also take a width cap, for the reason spelled
              // out in `sheet.tsx`: a caller's `w-full` is 100% of the viewport on
              // a fixed element, so a margin alone would displace it rather than
              // narrow it.
              "data-[swipe-direction=left]:mt-safe-top data-[swipe-direction=left]:ml-safe-left data-[swipe-direction=left]:max-w-safe-dvw data-[swipe-direction=right]:mt-safe-top data-[swipe-direction=right]:mr-safe-right data-[swipe-direction=right]:max-w-safe-dvw",
              typeof className === "function" ? className(state) : className,
            )
          }
          {...props}
        >
          <div className="mx-auto mt-3 hidden h-1.5 w-12 shrink-0 rounded-full bg-border group-data-[swipe-direction=down]/drawer-content:block" />
          {children}
        </DrawerPrimitive.Popup>
      </DrawerPrimitive.Viewport>
    </DrawerPortal>
  );
}

function DrawerHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-header"
      className={cn("flex flex-col gap-0.5 p-4", className)}
      {...props}
    />
  );
}

function DrawerFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  );
}

function DrawerTitle({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Title>) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={(state) =>
        cn(
          "font-heading text-ui font-medium text-foreground",
          typeof className === "function" ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

function DrawerDescription({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Description>) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn("text-ui-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Drawer,
  DrawerPortal,
  DrawerOverlay,
  DrawerTrigger,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
};
