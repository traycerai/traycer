import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";

import { cn } from "@/lib/utils";
import { InputGroup, InputGroupAddon } from "@/components/ui/input-group";
import { SearchIcon, CheckIcon } from "lucide-react";
import { Kbd } from "@/components/ui/kbd";
import { ShortcutHint } from "@/components/ui/shortcut-hint";

function Command({
  className,
  variant = "standalone",
  selection = "lifted",
  ...props
}: React.ComponentProps<typeof CommandPrimitive> & {
  /**
   * `standalone` is the palette drawn as its own plate. `embedded` is the same
   * list inside a surface that already drew one - a popover, a pane - so it
   * contributes no plate of its own. Five surfaces hand-wrote that as some
   * subset of `rounded-none bg-transparent p-0`, and disagreed about which
   * parts to include.
   */
  readonly variant?: "standalone" | "embedded";
  /**
   * How the keyboard cursor is drawn. `lifted` is the default palette row: a
   * primary tint, a border and a shadow, for a list of ACTIONS where the
   * cursor is the only state a row has.
   *
   * `flat` is for a picker of VALUES, where a row can also be the CHOSEN one -
   * which the primitive marks with the same primary. Two pickers cancelled the
   * lift by hand so the two states stay distinguishable; with `flat` the
   * cursor is a neutral fill and primary means "this is the current value".
   */
  readonly selection?: "lifted" | "flat";
}) {
  return (
    <CommandPrimitive
      data-slot="command"
      data-variant={variant}
      data-selection={selection}
      className={cn(
        "group/command flex size-full flex-col overflow-hidden text-popover-foreground",
        variant === "embedded"
          ? "bg-transparent p-0"
          : "rounded-xl bg-[var(--command-surface-background,var(--popover))] p-1",
        className,
      )}
      {...props}
    />
  );
}

function CommandInput({
  className,
  leading,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input> & {
  /**
   * Optional leading affordance rendered in place of the search icon - e.g. a
   * back button when the surface has drilled into a sub-page.
   */
  leading?: React.ReactNode;
}) {
  return (
    <div data-slot="command-input-wrapper" className="p-1 pb-0">
      <InputGroup
        variant="search"
        className="h-8! border-[color-mix(in_srgb,var(--input)_30%,var(--popover))] bg-[color-mix(in_srgb,var(--input)_30%,var(--popover))]!"
      >
        <CommandPrimitive.Input
          data-slot="command-input"
          className={cn(
            "w-full text-ui-sm outline-hidden disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
          {...props}
        />
        <InputGroupAddon>
          {leading ?? <SearchIcon className="size-4 shrink-0 opacity-50" />}
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

function CommandList({
  className,
  ref,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      ref={ref}
      data-slot="command-list"
      className={cn(
        // `overflow-anchor:none` is required: cmdk physically re-sorts the item
        // DOM nodes on every keystroke, and the browser's scroll-anchoring would
        // otherwise fight cmdk's own scroll-into-view and leave the active item
        // scrolled out of view.
        "no-scrollbar max-h-72 scroll-py-1 overflow-x-hidden overflow-y-auto outline-none [overflow-anchor:none]",
        className,
      )}
      {...props}
    />
  );
}

function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn("py-6 text-center text-ui-sm", className)}
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "overflow-hidden p-1 text-foreground **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:text-ui-xs **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("-mx-1 h-px bg-border", className)}
      {...props}
    />
  );
}

/**
 * Selected-state utilities are spelled `data-[selected=true]:`, never the
 * shorter bare `data-selected:`. cmdk sets the attribute on EVERY item
 * (`"data-selected": !!selected`, which React stringifies to `"false"`), and
 * Tailwind compiles the bare form to an attribute-PRESENCE selector - so it
 * matches every row and the "selected" styling has no unselected state to
 * contrast with. That held for this row's fill, border, shadow and icon tint
 * simultaneously, which is why it read as a theme rather than as a bug.
 *
 * `src/__tests__/data-selected-value-form-lint.test.ts` keeps the bare form
 * out of the tree; `__tests__/command-selected-state.test.tsx` checks that the
 * compiled rules actually discriminate.
 */
function CommandItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "group/command-item relative flex cursor-default items-center gap-2 rounded-sm border border-transparent px-2 py-1.5 text-ui-sm outline-hidden select-none transition-[background-color,border-color,box-shadow,color] duration-150 in-data-[slot=dialog-content]:rounded-lg hover:bg-[color-mix(in_srgb,var(--foreground)_6%,var(--popover))] hover:text-foreground active:press-scrim data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:border-primary/35 data-[selected=true]:bg-[color-mix(in_srgb,var(--primary)_14%,var(--popover))] data-[selected=true]:text-foreground data-[selected=true]:shadow-sm [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[selected=true]:*:[svg]:text-primary",
        // `selection="flat"` (see `Command`): the cursor stops competing with
        // the primary the CHOSEN row is marked in. A foreground alpha rather
        // than `bg-accent`, which both sites reached for and which AGENTS.md
        // rules out on a raised surface.
        "group-data-[selection=flat]/command:data-[selected=true]:border-transparent group-data-[selection=flat]/command:data-[selected=true]:bg-foreground/8 group-data-[selection=flat]/command:data-[selected=true]:shadow-none group-data-[selection=flat]/command:data-[selected=true]:*:[svg]:text-current",
        // …and the primary it gave up is what the CHOSEN row takes instead,
        // which is the whole point of the split.
        "group-data-[selection=flat]/command:data-[checked=true]:text-primary",
        className,
      )}
      {...props}
    >
      {children}
      <CheckIcon className="ml-auto opacity-0 group-has-data-[slot=command-shortcut]/command-item:hidden group-data-[checked=true]/command-item:opacity-100" />
    </CommandPrimitive.Item>
  );
}

// The row's trailing chord chip. Gated as a whole rather than at its one call
// site: the wrapper span is also what `CommandItem` keys its check-mark off
// (`group-has-data-[slot=command-shortcut]`), so a bound command must either
// show its chord or read as a plain row.
function CommandShortcut({
  className,
  children,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <ShortcutHint>
      <span
        data-slot="command-shortcut"
        className={cn(
          "ml-auto text-ui-xs text-muted-foreground group-data-[selected=true]/command-item:text-foreground",
          className,
        )}
        {...props}
      >
        {/* Repeated on the keycap because the span above only sets an INHERITED
            color, and `Kbd` paints its own `text-muted-foreground` directly on
            the element, which beats it. */}
        <Kbd
          className="tabular-nums group-data-[selected=true]/command-item:text-foreground"
          variant="mono"
        >
          {children}
        </Kbd>
      </span>
    </ShortcutHint>
  );
}

export {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
};
