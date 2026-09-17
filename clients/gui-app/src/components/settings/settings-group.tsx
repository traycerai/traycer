import type { ReactNode } from "react";
import type { SettingsGroupDefinition } from "@/lib/settings-search/settings-definitions";
import { cn } from "@/lib/utils";
import { useSettingsDensity } from "@/providers/settings-density-context";

interface SettingsGroupProps {
  /**
   * The group's label and settings-search anchor, from the same definition the
   * search index reads (see `lib/settings-search/settings-definitions.ts`).
   *
   * The anchor goes on the CARD, not on the `<section>` that also holds the
   * heading. The heading sits outside the card by design (see below) with its
   * own spacing, so a mark spanning the section drew a filled box around the
   * label and a strip of empty gutter beneath it — the group's contents and
   * its name lit up as one shape, which is not the shape the group has at
   * rest. Marking the card alone matches what the border already draws, and
   * the heading a line above stays legible without being part of the flash.
   */
  readonly group: SettingsGroupDefinition;
  /**
   * Whether the label is drawn outside the card. `false` when the page heading
   * already names this group — a second word next to it is a duplicate, not
   * orientation.
   */
  readonly showTitle: boolean;
  readonly tone: "default" | "danger";
  readonly dataTestId: string | undefined;
  readonly children: ReactNode;
  /**
   * When true, the section and its bordered card stretch to fill the height
   * of their flex parent instead of sizing to content - the section becomes a
   * `flex h-full min-h-0 flex-col` column and the card becomes `min-h-0
   * flex-1`, so a scrollable child can own the remaining height. This is the
   * typed, local form of a "fill the rest of the height" contract that used
   * to be bolted on from outside via fragile `[&>section]`/`[&>section>div]`
   * descendant selectors keyed to this component's exact internal markup.
   * Off by default - most groups size to their content.
   */
  readonly fill: boolean;
}

/**
 * A named group of settings rows: a small, quiet label sits OUTSIDE the
 * bordered card containing its rows, so orientation (the label) and action
 * (the card) use different visual grammar - a group label must never read as
 * another setting row. `danger` reuses the same shape with a restrained-red
 * tone for Danger Zone instead of a separate component.
 */
export function SettingsGroup(props: SettingsGroupProps): ReactNode {
  const { group, showTitle, tone, dataTestId, children, fill } = props;
  const compact = useSettingsDensity() === "compact";
  return (
    <section
      data-testid={dataTestId}
      className={cn(fill && "flex h-full min-h-0 flex-col")}
    >
      {showTitle ? (
        <h2
          className={cn(
            "px-1 font-semibold text-ui-xs text-muted-foreground",
            compact ? "mb-1" : "mb-1.5",
            tone === "danger" && "text-destructive/80",
            fill && "shrink-0",
          )}
        >
          {group.label}
        </h2>
      ) : null}
      <div
        data-settings-anchor={group.anchor ?? undefined}
        className={cn(
          // `clip` rather than `hidden`, and the difference is not cosmetic:
          // both clip a row to the card's rounded corners, but `hidden` makes
          // the card a SCROLLPORT, and a `position: sticky` child then anchors
          // to a box that never scrolls - which reads as sticky silently doing
          // nothing (Layout ▸ Status bar pins its preview this way).
          "overflow-clip rounded-lg border border-border/60 bg-card/40",
          tone === "danger" && "border-destructive/30 bg-destructive/5",
          fill && "min-h-0 flex-1",
        )}
      >
        {children}
      </div>
    </section>
  );
}
