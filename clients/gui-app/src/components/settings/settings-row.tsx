import type { ReactNode } from "react";
import { SETTINGS_ROW_STACK } from "@/components/settings/settings-row-layout";
import { cn } from "@/lib/utils";
import { useSettingsDensity } from "@/providers/settings-density-context";

interface SettingsRowProps {
  label: string;
  description?: string;
  /**
   * A standing risk disclosure, always rendered when present (unlike
   * `hint`, which is conditional). Reserved for accepted-risk copy that
   * must not be softened or hidden behind an expander - see the
   * "In-app browser (beta)" row.
   */
  risk?: ReactNode;
  hint?: ReactNode;
  control: ReactNode;
}

export function SettingsRow(props: SettingsRowProps) {
  const { label, description, risk, hint, control } = props;
  const compact = useSettingsDensity() === "compact";
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-x-6 gap-y-2 border-b border-border/40 last:border-b-0",
        SETTINGS_ROW_STACK.container,
        compact ? "px-4 py-2.5" : "px-5 py-4",
      )}
    >
      <div
        className={cn("min-w-[50%] flex-1 space-y-1", SETTINGS_ROW_STACK.label)}
      >
        <div className="font-medium text-foreground">{label}</div>
        {description ? (
          <p className="text-ui-sm text-muted-foreground">{description}</p>
        ) : null}
        {risk ? (
          <p className="text-ui-sm font-medium text-amber-700 dark:text-amber-300">
            {risk}
          </p>
        ) : null}
        {hint ? (
          <p className="text-ui-sm font-medium text-amber-700 dark:text-amber-300">
            {hint}
          </p>
        ) : null}
      </div>
      <div
        className={cn(
          "ml-auto flex max-w-full shrink-0 justify-end [&>*]:max-w-full",
          SETTINGS_ROW_STACK.control,
        )}
      >
        {control}
      </div>
    </div>
  );
}
