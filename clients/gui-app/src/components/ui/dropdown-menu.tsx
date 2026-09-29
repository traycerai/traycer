import * as React from "react";
import { Menu as DropdownMenuPrimitive } from "@base-ui/react/menu";

import {
  ClosingOverlayContext,
  useClosingOverlay,
  useClosingOverlayFocus,
  type PresentationLossDetails,
} from "@/components/ui/closing-overlay-presentation";
import { mergeRefs } from "@/lib/merge-refs";
import { cn } from "@/lib/utils";
import { CheckIcon, ChevronRightIcon } from "lucide-react";

import { useDialogOverlayBoundaryEl } from "@/providers/dialog-overlay-boundary-context";

import { useSafeAreaCollisionPadding } from "@/components/ui/safe-area-collision-padding";
import { MenuOpenMarker } from "@/components/ui/open-menus";

function DropdownMenu({
  open,
  defaultOpen,
  onOpenChange,
  onOpenChangeComplete,
  ...props
}: Omit<DropdownMenuPrimitive.Root.Props, "onOpenChange" | "actionsRef"> & {
  onOpenChange?: (
    open: boolean,
    details:
      | DropdownMenuPrimitive.Root.ChangeEventDetails
      | PresentationLossDetails,
  ) => void;
}) {
  const actions = React.useRef<DropdownMenuPrimitive.Root.Actions>(null);
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
      <DropdownMenuPrimitive.Root
        {...props}
        actionsRef={actions}
        open={overlay.open}
        onOpenChange={overlay.onOpenChange}
        onOpenChangeComplete={overlay.onOpenChangeComplete}
      />
    </ClosingOverlayContext.Provider>
  );
}

function DropdownMenuPortal({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) {
  return (
    <DropdownMenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />
  );
}

function DropdownMenuTrigger({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return (
    <DropdownMenuPrimitive.Trigger
      data-slot="dropdown-menu-trigger"
      {...props}
    />
  );
}

type DropdownMenuPositionProps = Pick<
  DropdownMenuPrimitive.Positioner.Props,
  | "side"
  | "sideOffset"
  | "align"
  | "alignOffset"
  | "collisionBoundary"
  | "collisionPadding"
  | "collisionAvoidance"
>;
type DropdownMenuContentProps = React.ComponentProps<
  typeof DropdownMenuPrimitive.Popup
> &
  DropdownMenuPositionProps & {
    readonly container?: React.ComponentProps<
      typeof DropdownMenuPrimitive.Portal
    >["container"];
  };

function DropdownMenuContent({
  ref,
  className,
  align = "start",
  side,
  sideOffset = 4,
  alignOffset,
  collisionPadding,
  collisionBoundary,
  collisionAvoidance,
  finalFocus,
  container,
  children,
  ...props
}: DropdownMenuContentProps) {
  const focus = useClosingOverlayFocus(finalFocus);
  const safeAreaInsets = useSafeAreaCollisionPadding();
  return (
    <DropdownMenuPrimitive.Portal
      container={container ?? undefined}
      data-overlay-concealed={focus.concealed || undefined}
    >
      <DropdownMenuPrimitive.Positioner
        data-slot="dropdown-menu-positioner"
        positionMethod="fixed"
        className="z-50"
        data-overlay-concealed={focus.concealed || undefined}
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        collisionBoundary={collisionBoundary}
        collisionAvoidance={collisionAvoidance}
        collisionPadding={collisionPadding ?? safeAreaInsets}
      >
        <DropdownMenuPrimitive.Popup
          ref={mergeRefs(ref, focus.popup)}
          data-slot="dropdown-menu-content"
          data-overlay-concealed={focus.concealed || undefined}
          finalFocus={focus.finalFocus}
          className={(state) =>
            cn(
              "z-50 max-h-(--available-height) w-(--anchor-width) max-w-safe-dvw min-w-32 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-closed:overflow-hidden data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
              typeof className === "function" ? className(state) : className,
            )
          }
          {...props}
        >
          {/* Mounted with the open menu: no hover card opens meanwhile. */}
          <MenuOpenMarker />
          {children}
        </DropdownMenuPrimitive.Popup>
      </DropdownMenuPrimitive.Positioner>
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  return (
    <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
  );
}

/**
 * Every tappable ROW here - this one, the checkbox and radio items, and the
 * sub-trigger - owns its coarse-pointer target through its own height
 * (`pointer-coarse:min-h-11`), the same way `ui/select.tsx` sizes `SelectItem`.
 * Keep the four in step: a row left behind reads as a ragged list on touch, and
 * is the one that gets mis-tapped.
 *
 * Rows deliberately do NOT use the invisible `::after` slop that the
 * `[data-*-touch-scope]` stylesheets give buttons and menu TRIGGERS. Either
 * half of the reason rules it out on its own:
 *
 * - `DropdownMenuContent` renders through `DropdownMenuPrimitive.Portal`, so a
 *   row is never a descendant of the surface that opened it. A scope attribute
 *   cannot reach it, and a rule written as if it could is silently dead - which
 *   is how a trigger ends up with a larger hit area than the rows it opens.
 * - Rows stack flush, so slop that overhangs by design would reach into the
 *   neighbouring row and take its tap.
 *
 * The rows grow on touch only; `items-center` keeps the label and any indicator
 * centred in whatever height that yields, and pointer devices keep the dense
 * list.
 */
function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean;
  variant?: "default" | "destructive" | "muted";
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={(state) =>
        cn(
          "group/dropdown-menu-item relative flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-ui-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-inset:pl-7 data-[variant=muted]:text-muted-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-50 aria-disabled:opacity-50 pointer-coarse:min-h-11 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[variant=destructive]:*:[svg]:text-destructive",
          typeof className === "function" ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  closeOnClick = true,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      closeOnClick={closeOnClick}
      data-slot="dropdown-menu-checkbox-item"
      data-inset={inset}
      className={(state) =>
        cn(
          "relative flex cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-ui-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-inset:pl-7 data-checked:bg-foreground/5 data-disabled:pointer-events-none data-disabled:opacity-50 aria-disabled:opacity-50 pointer-coarse:min-h-11 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
          typeof className === "function" ? className(state) : className,
        )
      }
      checked={checked}
      {...props}
    >
      <span
        className="pointer-events-none absolute right-2 flex items-center justify-center"
        data-slot="dropdown-menu-checkbox-item-indicator"
      >
        <DropdownMenuPrimitive.CheckboxItemIndicator
          keepMounted={props["aria-checked"] === "mixed"}
        >
          <CheckIcon />
        </DropdownMenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuRadioGroup({
  onValueChange,
  ...props
}: Omit<
  DropdownMenuPrimitive.RadioGroup.Props,
  "value" | "defaultValue" | "onValueChange"
> & {
  value?: string;
  defaultValue?: string;
  onValueChange?: (
    value: string,
    details: DropdownMenuPrimitive.RadioGroup.ChangeEventDetails,
  ) => void;
}) {
  return (
    <DropdownMenuPrimitive.RadioGroup
      data-slot="dropdown-menu-radio-group"
      {...props}
      onValueChange={(value: unknown, details) => {
        if (typeof value === "string") onValueChange?.(value, details);
      }}
    />
  );
}

function DropdownMenuRadioItem({
  className,
  children,
  inset,
  closeOnClick = true,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.RadioItem
      closeOnClick={closeOnClick}
      data-slot="dropdown-menu-radio-item"
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
        data-slot="dropdown-menu-radio-item-indicator"
      >
        <DropdownMenuPrimitive.RadioItemIndicator>
          <CheckIcon />
        </DropdownMenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

/**
 * A menu label is a SECTION HEADING, and it is drawn as one: the overline rank,
 * uppercase, with the tracking that rank needs to stay readable.
 *
 * That treatment used to live at the call sites - fourteen of the twenty-four
 * labels in the app wrote some spelling of `text-overline uppercase
 * tracking-wide`, and they disagreed (three reached for `text-ui-xs
 * font-medium`, three dropped the tracking, six dimmed to
 * `text-muted-foreground/70`). It is one heading style, so it is stated once
 * here and nowhere else.
 */
function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<"div"> & {
  inset?: boolean;
}) {
  return (
    <div
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        "px-1.5 py-1 text-overline tracking-wide uppercase text-muted-foreground data-inset:pl-7",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

function DropdownMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(
        "ml-auto text-ui-xs text-muted-foreground group-focus/dropdown-menu-item:text-accent-foreground",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSub({
  open,
  defaultOpen,
  onOpenChange,
  onOpenChangeComplete,
  ...props
}: Omit<
  DropdownMenuPrimitive.SubmenuRoot.Props,
  "onOpenChange" | "actionsRef"
> & {
  onOpenChange?: (
    open: boolean,
    details:
      | DropdownMenuPrimitive.SubmenuRoot.ChangeEventDetails
      | PresentationLossDetails,
  ) => void;
}) {
  const actions = React.useRef<DropdownMenuPrimitive.Root.Actions>(null);
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
      <DropdownMenuPrimitive.SubmenuRoot
        {...props}
        actionsRef={actions}
        open={overlay.open}
        onOpenChange={overlay.onOpenChange}
        onOpenChangeComplete={overlay.onOpenChangeComplete}
      />
    </ClosingOverlayContext.Provider>
  );
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubmenuTrigger> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={(state) =>
        cn(
          "flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-ui-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-inset:pl-7 data-popup-open:bg-accent data-popup-open:text-accent-foreground pointer-coarse:min-h-11 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
          typeof className === "function" ? className(state) : className,
        )
      }
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto" />
    </DropdownMenuPrimitive.SubmenuTrigger>
  );
}

type DropdownMenuSubContentProps = React.ComponentProps<
  typeof DropdownMenuPrimitive.Popup
> &
  DropdownMenuPositionProps & {
    readonly container?: React.ComponentProps<
      typeof DropdownMenuPrimitive.Portal
    >["container"];
    /**
     * `menu` is a list of rows and gets the row gutter. `panel` is a submenu
     * holding a small FORM or a paragraph rather than rows - the add-node
     * launcher, the browser's site-information card - which needs a reading
     * margin and body type instead. Both sites built it by hand and disagreed
     * (`p-2` against `p-3`); this is that composition with one name. The rhythm
     * BETWEEN the panel's children stays the caller's, because only the caller
     * knows how many there are.
     */
    readonly layout?: "menu" | "panel";
  };

function DropdownMenuSubContent({
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
  container,
  layout = "menu",
  ...props
}: DropdownMenuSubContentProps) {
  const focus = useClosingOverlayFocus(finalFocus);
  const dialogBoundary = useDialogOverlayBoundaryEl();
  // A submenu opens sideways from a row that is itself already near an edge, so
  // it is the surface most likely to need the clamp its parent content has.
  const safeAreaInsets = useSafeAreaCollisionPadding();
  return (
    <DropdownMenuPrimitive.Portal
      container={container ?? dialogBoundary ?? undefined}
      data-overlay-concealed={focus.concealed || undefined}
    >
      <DropdownMenuPrimitive.Positioner
        data-slot="dropdown-menu-positioner"
        positionMethod="fixed"
        data-overlay-concealed={focus.concealed || undefined}
        className="z-50 transform-3d"
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        collisionBoundary={collisionBoundary}
        collisionAvoidance={collisionAvoidance ?? { fallbackAxisSide: "none" }}
        collisionPadding={collisionPadding ?? safeAreaInsets}
      >
        <DropdownMenuPrimitive.Popup
          ref={mergeRefs(ref, focus.popup)}
          finalFocus={focus.finalFocus}
          data-overlay-concealed={focus.concealed || undefined}
          data-slot="dropdown-menu-sub-content"
          data-layout={layout}
          className={(state) =>
            cn(
              "z-50 max-w-safe-dvw min-w-24 origin-(--transform-origin) overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/10 duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
              layout === "panel" ? "p-3 text-ui-sm" : "p-1",
              typeof className === "function" ? className(state) : className,
            )
          }
          {...props}
        />
      </DropdownMenuPrimitive.Positioner>
    </DropdownMenuPrimitive.Portal>
  );
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};
