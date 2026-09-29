import type { ComponentProps } from "react";
import { Menubar as MenubarPrimitive } from "@base-ui/react/menubar";
import { Menu as Primitive } from "@base-ui/react/menu";
import { isToastEvent } from "@/components/ui/overlay-guards";
import { cn } from "@/lib/utils";
import { useSafeAreaCollisionPadding } from "@/components/ui/safe-area-collision-padding";

export function Menubar(props: ComponentProps<typeof MenubarPrimitive>) {
  return <MenubarPrimitive {...props} />;
}
export function MenubarMenu({ onOpenChange, ...props }: Primitive.Root.Props) {
  return (
    <Primitive.Root
      {...props}
      onOpenChange={(open, details) => {
        if (!open && isToastEvent(details)) details.cancel();
        else onOpenChange?.(open, details);
      }}
    />
  );
}
// The app's one menubar draws the hover, open and focus treatments on a span
// INSIDE the trigger, because the trigger is full-height and the pill is not.
// What the trigger itself owns is the type step, the resting label colour and
// the outline it hands to that span - which is exactly what the single call
// site was writing back on.
const TRIGGER_CLASS =
  "group inline-flex h-full items-center text-ui-xs text-canvas-foreground/70 outline-none select-none";

export function MenubarTrigger(
  props: ComponentProps<typeof Primitive.Trigger>,
) {
  const { className, ...rest } = props;
  return (
    <Primitive.Trigger
      className={(state) =>
        cn(
          TRIGGER_CLASS,
          typeof className === "function" ? className(state) : className,
        )
      }
      {...rest}
    />
  );
}
const CONTENT_CLASS =
  "z-50 max-h-(--available-height) max-w-safe-dvw min-w-48 overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 [-webkit-app-region:no-drag]";
const ITEM_CLASS =
  "relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-ui-sm outline-none select-none data-highlighted:bg-foreground/8 data-disabled:pointer-events-none data-disabled:opacity-40 pointer-coarse:min-h-11";

export function MenubarContent(
  props: ComponentProps<typeof Primitive.Popup> &
    Pick<Primitive.Positioner.Props, "collisionPadding">,
) {
  const { className, collisionPadding, ...rest } = props;
  const insets = useSafeAreaCollisionPadding();
  return (
    <Primitive.Portal>
      <Primitive.Positioner
        data-slot="menubar-positioner"
        positionMethod="fixed"
        className="z-50"
        align="start"
        sideOffset={0}
        collisionPadding={collisionPadding ?? insets}
      >
        <Primitive.Popup
          className={(state) =>
            cn(
              CONTENT_CLASS,
              typeof className === "function" ? className(state) : className,
            )
          }
          {...rest}
        />
      </Primitive.Positioner>
    </Primitive.Portal>
  );
}
export function MenubarItem(props: ComponentProps<typeof Primitive.Item>) {
  const { className, ...rest } = props;
  return (
    <Primitive.Item
      className={(state) =>
        cn(
          ITEM_CLASS,
          typeof className === "function" ? className(state) : className,
        )
      }
      {...rest}
    />
  );
}
export function MenubarSeparator(
  props: ComponentProps<typeof Primitive.Separator>,
) {
  const { className, ...rest } = props;
  return (
    <Primitive.Separator
      className={cn("my-1 h-px bg-border", className)}
      {...rest}
    />
  );
}
export function MenubarSub({
  onOpenChange,
  ...props
}: ComponentProps<typeof Primitive.SubmenuRoot>) {
  return (
    <Primitive.SubmenuRoot
      {...props}
      onOpenChange={(open, details) => {
        if (!open && isToastEvent(details)) details.cancel();
        else onOpenChange?.(open, details);
      }}
    />
  );
}
export function MenubarSubTrigger(
  props: ComponentProps<typeof Primitive.SubmenuTrigger>,
) {
  const { className, ...rest } = props;
  return (
    <Primitive.SubmenuTrigger
      className={(state) =>
        cn(
          ITEM_CLASS,
          typeof className === "function" ? className(state) : className,
        )
      }
      {...rest}
    />
  );
}
export function MenubarSubContent(
  props: ComponentProps<typeof Primitive.Popup> &
    Pick<Primitive.Positioner.Props, "collisionPadding">,
) {
  const { className, collisionPadding, ...rest } = props;
  const insets = useSafeAreaCollisionPadding();
  return (
    <Primitive.Portal>
      <Primitive.Positioner
        data-slot="menubar-positioner"
        positionMethod="fixed"
        className="z-50"
        side="right"
        align="start"
        alignOffset={0}
        collisionAvoidance={{ fallbackAxisSide: "none" }}
        collisionPadding={collisionPadding ?? insets}
      >
        <Primitive.Popup
          className={(state) =>
            cn(
              CONTENT_CLASS,
              typeof className === "function" ? className(state) : className,
            )
          }
          {...rest}
        />
      </Primitive.Positioner>
    </Primitive.Portal>
  );
}
