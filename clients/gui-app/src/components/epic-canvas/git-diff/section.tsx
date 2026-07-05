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
  readonly fillAvailable: boolean;
  readonly compactChrome: boolean;
  readonly children: ReactNode;
}

function sectionRootClassName(args: {
  readonly compactChrome: boolean;
  readonly expandsToFillSpace: boolean;
}): string {
  return cn(
    "flex min-h-0 flex-col",
    args.compactChrome ? "py-0" : "py-1",
    args.expandsToFillSpace ? "flex-1 basis-0" : "flex-none",
  );
}

function sectionChromeClassName(args: {
  readonly compactChrome: boolean;
  readonly collapsed: boolean;
  readonly isEmpty: boolean;
}): string {
  if (args.compactChrome) {
    return cn(
      "group relative flex w-full min-w-0 items-center overflow-hidden bg-background px-2 py-1 transition-colors hover:bg-muted",
      "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2",
    );
  }
  return cn(
    "group relative flex min-w-0 items-center overflow-hidden rounded-md px-1 py-0.5 transition-colors hover:bg-accent/50",
    "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2",
    args.isEmpty ? "bg-muted/10" : "bg-muted/20",
    !args.collapsed && !args.isEmpty && "bg-muted/30",
  );
}

function sectionTitleClassName(args: {
  readonly compactChrome: boolean;
  readonly isEmpty: boolean;
}): string {
  return cn(
    "whitespace-nowrap font-medium uppercase tracking-wide",
    args.compactChrome ? "text-ui-xs" : "text-ui-sm",
    args.isEmpty ? "text-muted-foreground/70" : "text-foreground/90",
  );
}

function sectionBodyClassName(fillAvailable: boolean): string {
  return cn(
    "min-h-0 bg-background/70",
    fillAvailable ? "flex-1 overflow-hidden" : "overflow-visible",
  );
}

export function Section(props: SectionProps): ReactNode {
  const { title, count, summary, collapsed, onToggle, actions, children } =
    props;

  const expandsToFillSpace = props.fillAvailable && !collapsed && count > 0;
  const isEmpty = count === 0;
  const isExpanded = !collapsed && !isEmpty;
  const fileCountLabel = `${count} ${count === 1 ? "file" : "files"}`;

  return (
    <div
      className={sectionRootClassName({
        compactChrome: props.compactChrome,
        expandsToFillSpace,
      })}
    >
      <div
        className={cn(
          "shrink-0",
          props.compactChrome
            ? "sticky top-[var(--git-section-sticky-top,0px)] z-30 border-b border-border/30 bg-background"
            : "px-2",
        )}
      >
        <div
          className={sectionChromeClassName({
            compactChrome: props.compactChrome,
            collapsed,
            isEmpty,
          })}
        >
          <button
            type="button"
            onClick={onToggle}
            className={cn(
              "absolute inset-0 z-0 focus-visible:outline-none",
              props.compactChrome ? "rounded-none" : "rounded-md",
            )}
            aria-expanded={isExpanded}
            aria-label={`${title} section, ${fileCountLabel}`}
          />

          <div
            className={cn(
              "pointer-events-none relative z-10 flex min-w-0 flex-1 items-center gap-1.5 text-left",
              props.compactChrome ? "px-0 py-0" : "px-1.5 py-0.5",
            )}
          >
            <ChevronDown
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform",
                collapsed && "-rotate-90",
              )}
            />
            <span
              className={sectionTitleClassName({
                compactChrome: props.compactChrome,
                isEmpty,
              })}
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
        <div className={sectionBodyClassName(props.fillAvailable)}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
