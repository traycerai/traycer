import type { ReactNode } from "react";

interface SettingsRowProps {
  label: string;
  description?: string;
  control: ReactNode;
}

export function SettingsRow(props: SettingsRowProps) {
  const { label, description, control } = props;
  return (
    // flex-wrap + the label's basis keep small controls (switches) inline
    // beside the label while wide controls (pickers, selects) wrap below it
    // once the row gets narrow - no breakpoint, so it holds in any container.
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b border-border/40 px-5 py-4 last:border-b-0">
      <div className="min-w-0 grow basis-48 space-y-1">
        <div className="font-medium text-foreground">{label}</div>
        {description ? (
          <p className="text-ui-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="max-w-full shrink-0">{control}</div>
    </div>
  );
}
