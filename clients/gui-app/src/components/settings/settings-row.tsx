import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useSettingsDensity } from "@/providers/settings-density-context";

interface SettingsRowProps {
  label: string;
  description?: string;
  control: ReactNode;
}

export function SettingsRow(props: SettingsRowProps) {
  const { label, description, control } = props;
  const compact = useSettingsDensity() === "compact";
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-x-6 gap-y-2 border-b border-border/40 last:border-b-0",
        compact ? "px-4 py-2.5" : "px-5 py-4",
      )}
    >
      <div className="min-w-[50%] flex-1 space-y-1">
        <div className="font-medium text-foreground">{label}</div>
        {description ? (
          <p className="text-ui-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="ml-auto flex max-w-full shrink-0 justify-end [&>*]:max-w-full">
        {control}
      </div>
    </div>
  );
}
