import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Tabs as TabsPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-[orientation=horizontal]:flex-col",
        className,
      )}
      {...props}
    />
  );
}

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-0.75 text-muted-foreground group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-foreground/8",
        scope:
          "relative grid h-auto max-w-full grid-cols-3 rounded-[calc(var(--radius)+2px)] border border-border bg-foreground/4 p-0.5",
        // The RULE the strip sits on is part of this variant, not the
        // caller's. Every one of the four `line` lists in the app drew it by
        // hand and they disagreed - `border-border/60` three times and
        // `border-border` once, `pb-1.5` twice and `pb-2` once - while
        // `rounded-none` and `px-0` were restates of what the variant already
        // implies. A `line` list is a strip above a rule; a `default` one is a
        // filled track.
        line: "gap-1 rounded-none border-b border-border/60 bg-transparent px-0 pb-1.5",
      },
      size: {
        scope: "",
        default: "group-data-[orientation=horizontal]/tabs:h-8",
        sm: "group-data-[orientation=horizontal]/tabs:h-7",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function TabsList({
  className,
  variant = "default",
  size = "default",
  indicatorIndex,
  children,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants> & {
    readonly indicatorIndex?: number;
  }) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      data-size={size}
      className={cn(tabsListVariants({ variant, size }), className)}
      {...props}
    >
      {variant === "scope" ? (
        <span
          aria-hidden="true"
          data-slot="tabs-indicator"
          className="pointer-events-none absolute inset-y-0.5 left-0.5 w-[calc((100%_-_4px)/3)] rounded-md bg-foreground/12 transition-transform duration-160 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
          style={{ transform: `translateX(${(indicatorIndex ?? 0) * 100}%)` }}
        />
      ) : null}
      {children}
    </TabsPrimitive.List>
  );
}

function TabsTrigger({
  className,
  variant,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger> & {
  readonly variant?: "scope";
}) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        variant === "scope"
          ? "relative z-1 inline-flex min-h-7.5 min-w-0 items-center justify-center gap-1.5 rounded-md px-2.5 py-1.25 text-ui-xs whitespace-nowrap text-muted-foreground transition-colors duration-120 hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring data-[state=active]:font-semibold data-[state=active]:text-foreground"
          : cn(
              "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-ui-sm font-medium whitespace-nowrap text-foreground/60 transition-all group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start hover:text-foreground active:press-scrim focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 dark:text-muted-foreground dark:hover:text-foreground group-data-[variant=default]/tabs-list:data-[state=active]:shadow-sm group-data-[variant=line]/tabs-list:data-[state=active]:shadow-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
              "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent dark:group-data-[variant=line]/tabs-list:data-[state=active]:border-transparent dark:group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent",
              "data-[state=active]:bg-background data-[state=active]:text-foreground dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30 dark:data-[state=active]:text-foreground",
              "after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-[orientation=horizontal]/tabs:after:inset-x-0 group-data-[orientation=horizontal]/tabs:after:-bottom-1.25 group-data-[orientation=horizontal]/tabs:after:h-0.5 group-data-[orientation=vertical]/tabs:after:inset-y-0 group-data-[orientation=vertical]/tabs:after:-right-1 group-data-[orientation=vertical]/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-[state=active]:after:opacity-100",
              // The compact strip, read off the LIST so a tab bar cannot be half one
              // size and half the other. Five triggers across three surfaces wrote
              // `text-ui-xs`, two of them with `px-2.5 py-0` beside it.
              "group-data-[size=sm]/tabs-list:px-2.5 group-data-[size=sm]/tabs-list:py-0 group-data-[size=sm]/tabs-list:text-ui-xs",
            ),
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 text-ui-sm outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
