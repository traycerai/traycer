import type { ReactNode } from "react";
import type { StatusBadgeStyle } from "@/lib/git/status-icon";
import { cn } from "@/lib/utils";

const toneClass: Record<StatusBadgeStyle["tone"], string> = {
  success: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  destructive: "bg-red-500/10 text-red-600 dark:text-red-400",
  muted: "bg-muted text-muted-foreground",
  primary: "bg-primary/10 text-primary",
  warning: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
};

interface GitStatusBadgeBaseProps {
  readonly letter: string;
  readonly tone: StatusBadgeStyle["tone"];
  readonly label: string;
  /** Native title is off where a Radix tooltip already owns the row hover. */
  readonly withNativeTitle: boolean;
}

interface GitStatusBadgeClassNameProps extends GitStatusBadgeBaseProps {
  readonly className: string;
}

type GitStatusBadgeProps =
  GitStatusBadgeBaseProps | GitStatusBadgeClassNameProps;

export function GitStatusBadge(props: GitStatusBadgeProps): ReactNode {
  const className = "className" in props ? props.className : undefined;
  return (
    <span
      className={cn(
        "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded px-1 text-[10px] font-bold",
        toneClass[props.tone],
        className,
      )}
      title={props.withNativeTitle ? props.label : undefined}
      aria-label={props.label}
    >
      {props.letter}
    </span>
  );
}
