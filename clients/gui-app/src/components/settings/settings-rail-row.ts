import { cn } from "@/lib/utils";

/**
 * One rail row: the selected row filled, the rest receding until hovered.
 * A class rather than a component because the row element differs - a plain
 * button in the provider list, a tab trigger on the layout page.
 */
export function settingsRailRowClassName(active: boolean): string {
  return cn(
    "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-ui-sm transition-colors focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring",
    active
      ? "bg-accent text-accent-foreground"
      : "text-foreground/70 hover:bg-accent/60 hover:text-accent-foreground",
  );
}
