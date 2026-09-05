import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useSettingsDensity } from "@/providers/settings-density-context";

interface SettingsSubgroupProps {
  readonly title: string;
  readonly description: string | undefined;
  /** Sits before the title - a provider's brand mark, or nothing. */
  readonly icon: ReactNode;
  /**
   * The switch that governs everything inside, on the title row itself. `null`
   * for a band that only groups its rows.
   */
  readonly control: ReactNode;
  /**
   * Whether the children are drawn. A closed subgroup keeps its state - the
   * rows below configure something the parent switch has switched OFF, not
   * something the user has stopped meaning, so nothing is written when it
   * closes and everything is where it was when it opens.
   */
  readonly open: boolean;
  /**
   * Heading level, so nesting one subgroup inside another does not repeat a
   * level or skip one. `3` directly inside a `SettingsGroup`, `4` inside
   * another subgroup.
   */
  readonly level: 3 | 4;
  readonly dataTestId: string | undefined;
  readonly children: ReactNode;
}

/**
 * A group of rows INSIDE a `SettingsGroup`'s card, as a card of its own.
 *
 * Settings pages have historically expressed "these rows belong to that switch"
 * with indentation, which reads as decoration at a glance and disappears
 * entirely once two levels of it exist - which is exactly what a per-provider,
 * per-window list needs. An inset card draws the containment instead, so a
 * user can see where a subject starts and ends without counting pixels of
 * left margin.
 *
 * The title row can host the switch that owns the subgroup, and that pairing is
 * the reason this is not just a heading: a parent switch and the rows it
 * governs have to be one object on screen, or turning it off looks like the
 * page lost rows.
 */
export function SettingsSubgroup(props: SettingsSubgroupProps): ReactNode {
  const compact = useSettingsDensity() === "compact";
  const Heading = props.level === 3 ? "h3" : "h4";
  return (
    <div
      className={cn(
        "border-b border-border/40 last:border-b-0",
        compact ? "px-4 py-2.5" : "px-5 py-3.5",
      )}
    >
      <div
        data-testid={props.dataTestId}
        // An alpha of the foreground rather than `bg-muted`: every preset
        // theme's dark variant collapses `--muted` onto the card it would sit
        // on, and this card sits on another card.
        className="overflow-hidden rounded-lg border border-border/60 bg-foreground/3"
      >
        <div
          className={cn(
            "flex flex-wrap items-start justify-between gap-x-6 gap-y-2",
            compact ? "px-3 py-2" : "px-4 py-3",
            props.open && "border-b border-border/40",
          )}
        >
          <div className="min-w-[50%] flex-1 space-y-1">
            <Heading className="flex items-center gap-2 font-medium text-foreground">
              {props.icon}
              {props.title}
            </Heading>
            {props.description === undefined ? null : (
              <p className="max-w-[72ch] text-pretty text-ui-sm text-muted-foreground">
                {props.description}
              </p>
            )}
          </div>
          {props.control === null ? null : (
            <div className="ml-auto flex max-w-full shrink-0 justify-end">
              {props.control}
            </div>
          )}
        </div>
        {props.open ? props.children : null}
      </div>
    </div>
  );
}
