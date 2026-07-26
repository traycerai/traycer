import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useSettingsDensity } from "@/providers/settings-density-context";

interface SettingsGroupProps {
  readonly title: string;
  readonly tone: "default" | "danger";
  readonly dataTestId: string | undefined;
  readonly children: ReactNode;
}

/**
 * A named group of settings rows: a small, quiet label sits OUTSIDE the
 * bordered card containing its rows, so orientation (the label) and action
 * (the card) use different visual grammar - a group label must never read as
 * another setting row. `danger` reuses the same shape with a restrained-red
 * tone for Danger Zone instead of a separate component.
 */
export function SettingsGroup(props: SettingsGroupProps): ReactNode {
  const { title, tone, dataTestId, children } = props;
  const compact = useSettingsDensity() === "compact";
  return (
    <section data-testid={dataTestId}>
      <h2
        className={cn(
          "px-1 font-semibold text-ui-xs text-muted-foreground",
          compact ? "mb-1" : "mb-1.5",
          tone === "danger" && "text-destructive/80",
        )}
      >
        {title}
      </h2>
      <div
        className={cn(
          "overflow-hidden rounded-lg border border-border/60 bg-card/40",
          tone === "danger" && "border-destructive/30 bg-destructive/5",
        )}
      >
        {children}
      </div>
    </section>
  );
}
