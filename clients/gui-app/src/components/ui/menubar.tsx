import type { ComponentProps } from "react";
import { Menubar as Primitive } from "radix-ui";
import { cn } from "@/lib/utils";
import { useSafeAreaCollisionPadding } from "@/components/ui/safe-area-collision-padding";

export function Menubar(props: ComponentProps<typeof Primitive.Root>) {
  return <Primitive.Root {...props} />;
}
export function MenubarMenu(props: ComponentProps<typeof Primitive.Menu>) {
  return <Primitive.Menu {...props} />;
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
    <Primitive.Trigger className={cn(TRIGGER_CLASS, className)} {...rest} />
  );
}
const CONTENT_CLASS =
  "z-50 max-h-(--radix-menubar-content-available-height) max-w-safe-dvw min-w-48 overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 [-webkit-app-region:no-drag]";
const ITEM_CLASS =
  "relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-ui-sm outline-none select-none data-highlighted:bg-foreground/8 data-disabled:pointer-events-none data-disabled:opacity-40 pointer-coarse:min-h-11";

export function MenubarContent(
  props: ComponentProps<typeof Primitive.Content>,
) {
  const { className, collisionPadding, ...rest } = props;
  const insets = useSafeAreaCollisionPadding();
  return (
    <Primitive.Portal>
      <Primitive.Content
        align="start"
        sideOffset={0}
        collisionPadding={collisionPadding ?? insets}
        className={cn(CONTENT_CLASS, className)}
        {...rest}
      />
    </Primitive.Portal>
  );
}
export function MenubarItem(props: ComponentProps<typeof Primitive.Item>) {
  const { className, ...rest } = props;
  return <Primitive.Item className={cn(ITEM_CLASS, className)} {...rest} />;
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
export function MenubarSub(props: ComponentProps<typeof Primitive.Sub>) {
  return <Primitive.Sub {...props} />;
}
export function MenubarSubTrigger(
  props: ComponentProps<typeof Primitive.SubTrigger>,
) {
  const { className, ...rest } = props;
  return (
    <Primitive.SubTrigger className={cn(ITEM_CLASS, className)} {...rest} />
  );
}
export function MenubarSubContent(
  props: ComponentProps<typeof Primitive.SubContent>,
) {
  const { className, collisionPadding, ...rest } = props;
  const insets = useSafeAreaCollisionPadding();
  return (
    <Primitive.Portal>
      <Primitive.SubContent
        collisionPadding={collisionPadding ?? insets}
        className={cn(CONTENT_CLASS, className)}
        {...rest}
      />
    </Primitive.Portal>
  );
}
