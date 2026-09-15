import type { ReactNode } from "react";
import { SettingsRow } from "@/components/settings/settings-row";
import type { SettingsRowDefinition } from "@/lib/settings-search/settings-definitions";
import { cn } from "@/lib/utils";
import { useSettingsDensity } from "@/providers/settings-density-context";

/**
 * One lesson on Settings ▸ Onboarding: a settings row (label, description
 * and control from the definition, like every other row) that can open an
 * inline surface beneath it - a demo miniature today.
 *
 * The search anchor sits on THIS container rather than on the row inside
 * it, so a result that lands on the lesson lights the whole card, expanded
 * demo included, and so the card is one target rather than two. The row is
 * handed the definition with its anchor stripped for that reason; its copy
 * is untouched. The group's row divider moves out here too, since the row is
 * no longer the group's direct child; the row's own `last:` rule then draws
 * a divider only while a demo sits beneath it, which is the one place it
 * still reads as one.
 */
export function LessonCard(props: {
  readonly row: SettingsRowDefinition;
  readonly lessonId: string;
  readonly labelStatus: ReactNode;
  readonly status: ReactNode;
  readonly control: ReactNode;
  /** Rendered below the row while the lesson is open; `null` collapses it. */
  readonly expanded: ReactNode;
  readonly expandedId: string;
}): ReactNode {
  const compact = useSettingsDensity() === "compact";
  return (
    <div
      data-settings-anchor={props.row.anchor ?? undefined}
      data-testid={`onboarding-lesson-${props.lessonId}`}
      className="border-b border-border/40 last:border-b-0"
    >
      <SettingsRow
        row={{ ...props.row, anchor: null }}
        labelStatus={props.labelStatus}
        status={props.status}
        control={props.control}
      />
      {props.expanded === null ? null : (
        <div
          id={props.expandedId}
          className={cn(compact ? "px-4 pb-4" : "px-5 pb-5")}
        >
          {props.expanded}
        </div>
      )}
    </div>
  );
}
