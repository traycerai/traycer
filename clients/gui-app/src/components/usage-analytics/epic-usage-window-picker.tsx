import type { ReactNode } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type EpicUsageWindow = 7 | 30 | 90 | "epic";

export interface EpicUsageWindowPickerProps {
  readonly value: EpicUsageWindow;
  readonly onChange: (value: EpicUsageWindow) => void;
}

/**
 * Same anatomy as `UsageWindowPicker`, plus the epic-scoped panel's own
 * "Entire epic" option (ticket 10's `window: "epic"` - bounded by the
 * epic/chat's own fact span, not a general unbounded query).
 */
export function EpicUsageWindowPicker(
  props: EpicUsageWindowPickerProps,
): ReactNode {
  return (
    <Tabs
      value={String(props.value)}
      onValueChange={(value) => {
        if (value === "epic") {
          props.onChange("epic");
          return;
        }
        const parsed = Number(value);
        if (parsed === 7 || parsed === 30 || parsed === 90) {
          props.onChange(parsed);
        }
      }}
    >
      {/* The primitive is `w-fit` with `whitespace-nowrap` triggers, and this
          picker's four options are the widest set any of them carries. Its
          dialog is `w-[min(92vw,32rem)] overflow-hidden`, so at increased
          text scaling the row outgrows the box and clips "Entire epic" out of
          reach entirely - a lost option, not just a cramped one. Wrapping
          keeps every option clickable. */}
      <TabsList
        aria-label="Window"
        className="h-auto max-w-full flex-wrap group-data-horizontal/tabs:h-auto"
      >
        <TabsTrigger value="7" data-testid="epic-usage-window-7">
          7 days
        </TabsTrigger>
        <TabsTrigger value="30" data-testid="epic-usage-window-30">
          30 days
        </TabsTrigger>
        <TabsTrigger value="90" data-testid="epic-usage-window-90">
          90 days
        </TabsTrigger>
        <TabsTrigger value="epic" data-testid="epic-usage-window-epic">
          Entire epic
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
