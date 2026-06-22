import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SectionProps {
  readonly title: string;
  readonly count: number;
  readonly summary: ReactNode | null;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly actions: ReactNode;
  readonly children: ReactNode;
}

export function Section(props: SectionProps): ReactNode {
  const { title, count, summary, collapsed, onToggle, actions, children } =
    props;

  const expandsToFillSpace = !collapsed && count > 0;
  const isEmpty = count === 0;
  const isExpanded = !collapsed && !isEmpty;
  const fileCountLabel = `${count} ${count === 1 ? "file" : "files"}`;

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col py-1",
        expandsToFillSpace ? "flex-1 basis-0" : "flex-none",
      )}
    >
      <div className="shrink-0 px-2">
        <div
          className={cn(
            "group relative flex min-w-0 items-center overflow-hidden rounded-md px-1 py-0.5 transition-colors hover:bg-accent/50",
            "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2",
            isEmpty ? "bg-muted/10" : "bg-muted/20",
            !collapsed && !isEmpty && "bg-muted/30",
          )}
        >
          <button
            type="button"
            onClick={onToggle}
            className="absolute inset-0 z-0 rounded-md focus-visible:outline-none"
            aria-expanded={isExpanded}
            aria-label={`${title} section, ${fileCountLabel}`}
          />

          <div className="pointer-events-none relative z-10 flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-0.5 text-left">
            <ChevronDown
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform",
                collapsed && "-rotate-90",
              )}
            />
            <span
              className={cn(
                "whitespace-nowrap text-ui-sm font-medium uppercase tracking-wide",
                isEmpty ? "text-muted-foreground/70" : "text-foreground/90",
              )}
            >
              {title}
            </span>

            <span
              className={cn(
                "min-w-0 truncate whitespace-nowrap text-ui-xs tabular-nums",
                isEmpty ? "text-muted-foreground/55" : "text-muted-foreground",
              )}
              title={fileCountLabel}
            >
              {fileCountLabel}
            </span>

            <span aria-hidden className="ml-auto" />
            {summary}
          </div>

          <div className="relative z-20 flex shrink-0 items-center gap-0.5">
            {actions}
          </div>
        </div>
      </div>

      {!collapsed && count > 0 ? (
        <div className="min-h-0 flex-1 overflow-hidden bg-background/70">
          {children}
        </div>
      ) : null}
    </div>
  );
}
