import type { ReactNode } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { UsageSummaryWindowDays } from "@/hooks/usage-analytics/use-usage-summary-query";

const WINDOW_OPTIONS: ReadonlyArray<{
  readonly value: UsageSummaryWindowDays;
  readonly label: string;
}> = [
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
];

export interface UsageWindowPickerProps {
  readonly windowDays: UsageSummaryWindowDays;
  readonly onChange: (windowDays: UsageSummaryWindowDays) => void;
  /**
   * Extra classes merged onto each trigger - the styling seam the Tabs
   * primitive doesn't otherwise expose (its list hardcodes `h-8`), used by
   * the usage dialogs for coarse-pointer touch-target bumps. `undefined`
   * keeps the primitive's sizing (Settings).
   */
  readonly triggerClassName: string | undefined;
}

export function UsageWindowPicker(props: UsageWindowPickerProps): ReactNode {
  return (
    <Tabs
      value={String(props.windowDays)}
      onValueChange={(value) => {
        const parsed = Number(value);
        if (parsed === 7 || parsed === 30 || parsed === 90) {
          props.onChange(parsed);
        }
      }}
    >
      <TabsList aria-label="Window" className="max-w-full flex-wrap">
        {WINDOW_OPTIONS.map((option) => (
          <TabsTrigger
            key={option.value}
            value={String(option.value)}
            className={props.triggerClassName}
            data-testid={`usage-window-${String(option.value)}`}
          >
            {option.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
