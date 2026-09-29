import * as React from "react";
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import {
  ClosingOverlayContext,
  useClosingOverlay,
  useClosingOverlayFocus,
  type PresentationLossDetails,
} from "@/components/ui/closing-overlay-presentation";
import { mergeRefs } from "@/lib/merge-refs";
import { cn } from "@/lib/utils";

import { useDialogOverlayBoundaryEl } from "@/providers/dialog-overlay-boundary-context";

import { useSafeAreaCollisionPadding } from "@/components/ui/safe-area-collision-padding";
import { MenuOpenMarker } from "@/components/ui/open-menus";

function ContextMenu({
  open,
  defaultOpen,
  onOpenChange,
  onOpenChangeComplete,
  ...props
}: Omit<ContextMenuPrimitive.Root.Props, "onOpenChange" | "actionsRef"> & {
  onOpenChange?: (
    open: boolean,
    details:
      | ContextMenuPrimitive.Root.ChangeEventDetails
      | PresentationLossDetails,
  ) => void;
}) {
  const actions = React.useRef<ContextMenuPrimitive.Root.Actions>(null);
  const overlay = useClosingOverlay({
    open,
    defaultOpen,
    onOpenChange,
    onOpenChangeComplete,
    actions,
    select: false,
  });
  return (
    <ClosingOverlayContext.Provider value={overlay.presentation}>
      <ContextMenuPrimitive.Root
        {...props}
        actionsRef={actions}
        open={overlay.open}
        onOpenChange={overlay.onOpenChange}
        onOpenChangeComplete={overlay.onOpenChangeComplete}
      />
    </ClosingOverlayContext.Provider>
  );
}

function ContextMenuTrigger({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  return (
    <ContextMenuPrimitive.Trigger
      render={<span />}
      data-slot="context-menu-trigger"
      {...props}
    />
  );
}

type ContextMenuPositionProps = Pick<
  ContextMenuPrimitive.Positioner.Props,
  | "side"
  | "sideOffset"
  | "align"
  | "alignOffset"
  | "collisionBoundary"
  | "collisionPadding"
  | "collisionAvoidance"
>;
function ContextMenuContent({
  ref,
  className,
  align = "start",
  side = "right",
  sideOffset = 2,
  alignOffset,
  collisionPadding,
  collisionBoundary,
  collisionAvoidance,
  finalFocus,
  portalProps,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Popup> &
  ContextMenuPositionProps & {
    /** Escape hatch for a trigger zone that must stay interactive underneath
     *  the portal (pointer pass-through) while the menu itself stays
     *  clickable - the Positioner keeps `pointer-events-auto` regardless, so
     *  only the portal's own backdrop loses hit-testing. Public API only. */
    readonly portalProps?: React.ComponentProps<
      typeof ContextMenuPrimitive.Portal
    >;
  }) {
  const focus = useClosingOverlayFocus(finalFocus);
  const safeAreaInsets = useSafeAreaCollisionPadding();
  return (
    <ContextMenuPrimitive.Portal
      {...portalProps}
      data-overlay-concealed={focus.concealed || undefined}
    >
      <ContextMenuPrimitive.Positioner
        data-slot="context-menu-positioner"
        className="z-50 pointer-events-auto"
        data-overlay-concealed={focus.concealed || undefined}
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        collisionBoundary={collisionBoundary}
        collisionAvoidance={
          collisionAvoidance ?? {
            side: "flip",
            align: "shift",
            fallbackAxisSide: "none",
          }
        }
        collisionPadding={collisionPadding ?? safeAreaInsets}
      >
        <ContextMenuPrimitive.Popup
          ref={mergeRefs(ref, focus.popup)}
          data-slot="context-menu-content"
          data-overlay-concealed={focus.concealed || undefined}
          finalFocus={focus.finalFocus}
          className={(state) =>
            cn(
              "z-50 max-w-safe-dvw min-w-40 overflow-hidden rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:pointer-events-none data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
              typeof className === "function" ? className(state) : className,
            )
          }
          {...props}
        >
          {/* Mounted with the open menu: no hover card opens meanwhile. */}
          <MenuOpenMarker />
          {children}
        </ContextMenuPrimitive.Popup>
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

function ContextMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={(state) =>
        cn(
          "group/context-menu-item relative flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-ui-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-inset:pl-7 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive data-disabled:pointer-events-none data-disabled:opacity-50 aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[variant=destructive]:*:[svg]:text-destructive",
          typeof className === "function" ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

function ContextMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  closeOnClick = true,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.CheckboxItem> & {
  inset?: boolean;
}) {
  return (
    <ContextMenuPrimitive.CheckboxItem
      closeOnClick={closeOnClick}
      data-slot="context-menu-checkbox-item"
      data-inset={inset}
      className={(state) =>
        cn(
          "relative flex cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-ui-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
          typeof className === "function" ? className(state) : className,
        )
      }
      checked={checked}
      {...props}
    >
      <span
        className="pointer-events-none absolute right-2 flex items-center justify-center"
        data-slot="context-menu-checkbox-item-indicator"
      >
        <ContextMenuPrimitive.CheckboxItemIndicator
          keepMounted={props["aria-checked"] === "mixed"}
        >
          <CheckIcon />
        </ContextMenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.CheckboxItem>
  );
}

function ContextMenuRadioGroup({
  onValueChange,
  ...props
}: Omit<
  ContextMenuPrimitive.RadioGroup.Props,
  "value" | "defaultValue" | "onValueChange"
> & {
  value?: string;
  defaultValue?: string;
  onValueChange?: (
    value: string,
    details: ContextMenuPrimitive.RadioGroup.ChangeEventDetails,
  ) => void;
}) {
  return (
    <ContextMenuPrimitive.RadioGroup
      data-slot="context-menu-radio-group"
      {...props}
      onValueChange={(value: unknown, details) => {
        if (typeof value === "string") onValueChange?.(value, details);
      }}
    />
  );
}

function ContextMenuRadioItem({
  className,
  children,
  inset,
  closeOnClick = true,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.RadioItem> & {
  inset?: boolean;
}) {
  return (
    <ContextMenuPrimitive.RadioItem
      closeOnClick={closeOnClick}
      data-slot="context-menu-radio-item"
      data-inset={inset}
      className={(state) =>
        cn(
          "relative flex cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-ui-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-inset:pl-7 data-checked:bg-foreground/5 data-disabled:pointer-events-none data-disabled:opacity-50 aria-disabled:opacity-50 pointer-coarse:min-h-11 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
          typeof className === "function" ? className(state) : className,
        )
      }
      {...props}
    >
      <span
        className="pointer-events-none absolute right-2 flex items-center justify-center"
        data-slot="context-menu-radio-item-indicator"
      >
        <ContextMenuPrimitive.RadioItemIndicator>
          <CheckIcon />
        </ContextMenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.RadioItem>
  );
}

/** A section heading inside a menu, drawn like `DropdownMenuLabel`. */
function ContextMenuLabel({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="context-menu-label"
      className={cn(
        "px-1.5 py-1 text-overline tracking-wide uppercase text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function ContextMenuSub({
  open,
  defaultOpen,
  onOpenChange,
  onOpenChangeComplete,
  ...props
}: Omit<
  ContextMenuPrimitive.SubmenuRoot.Props,
  "onOpenChange" | "actionsRef"
> & {
  onOpenChange?: (
    open: boolean,
    details:
      | ContextMenuPrimitive.SubmenuRoot.ChangeEventDetails
      | PresentationLossDetails,
  ) => void;
}) {
  const actions = React.useRef<ContextMenuPrimitive.Root.Actions>(null);
  const overlay = useClosingOverlay({
    open,
    defaultOpen,
    onOpenChange,
    onOpenChangeComplete,
    actions,
    select: false,
  });
  return (
    <ClosingOverlayContext.Provider value={overlay.presentation}>
      <ContextMenuPrimitive.SubmenuRoot
        {...props}
        actionsRef={actions}
        open={overlay.open}
        onOpenChange={overlay.onOpenChange}
        onOpenChangeComplete={overlay.onOpenChangeComplete}
      />
    </ClosingOverlayContext.Provider>
  );
}

function ContextMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubmenuTrigger> & {
  inset?: boolean;
}) {
  return (
    <ContextMenuPrimitive.SubmenuTrigger
      data-slot="context-menu-sub-trigger"
      data-inset={inset}
      className={(state) =>
        cn(
          "flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-ui-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-inset:pl-7 data-popup-open:bg-accent data-popup-open:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
          typeof className === "function" ? className(state) : className,
        )
      }
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto" />
    </ContextMenuPrimitive.SubmenuTrigger>
  );
}

function ContextMenuSubContent({
  ref,
  finalFocus,
  className,
  collisionPadding,
  side = "right",
  sideOffset = 0,
  align = "start",
  alignOffset = 0,
  collisionBoundary,
  collisionAvoidance,
  layout = "menu",
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Popup> &
  ContextMenuPositionProps & {
    /** As on `DropdownMenuSubContent`: `menu` is a list of rows, `panel` a
     *  submenu holding a small control - the tab colour picker - which needs a
     *  reading margin rather than a row gutter. */
    readonly layout?: "menu" | "panel";
  }) {
  const focus = useClosingOverlayFocus(finalFocus);
  // A submenu opens sideways from a row that is itself already near an edge, so
  // it is the surface most likely to need the clamp its parent content has.
  const safeAreaInsets = useSafeAreaCollisionPadding();
  // Same boundary fallback as `DropdownMenuSubContent`: with no explicit
  // container, Radix portals to `document.body`, which can land the submenu
  // outside a dialog's own stacking context.
  const dialogBoundary = useDialogOverlayBoundaryEl();
  return (
    <ContextMenuPrimitive.Portal
      container={dialogBoundary ?? undefined}
      data-overlay-concealed={focus.concealed || undefined}
    >
      <ContextMenuPrimitive.Positioner
        data-slot="context-menu-positioner"
        data-overlay-concealed={focus.concealed || undefined}
        className="z-50"
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        collisionBoundary={collisionBoundary}
        collisionAvoidance={collisionAvoidance ?? { fallbackAxisSide: "none" }}
        collisionPadding={collisionPadding ?? safeAreaInsets}
      >
        <ContextMenuPrimitive.Popup
          ref={mergeRefs(ref, focus.popup)}
          finalFocus={focus.finalFocus}
          data-overlay-concealed={focus.concealed || undefined}
          data-slot="context-menu-sub-content"
          data-layout={layout}
          className={(state) =>
            cn(
              "z-50 max-w-safe-dvw min-w-24 overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:pointer-events-none data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
              layout === "panel" ? "p-3 text-ui-sm" : "p-1",
              typeof className === "function" ? className(state) : className,
            )
          }
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuCheckboxItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuLabel,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
};
