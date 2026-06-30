import type { ReactNode } from "react";
import type { StatusBadgeStyle } from "@/lib/git/status-icon";
import { cn } from "@/lib/utils";

const toneClass: Record<StatusBadgeStyle["tone"], string> = {
  success: "bg-success/10 text-success",
  destructive: "bg-destructive/10 text-destructive",
  muted: "bg-muted text-muted-foreground",
  primary: "bg-primary/10 text-primary",
  warning: "bg-warning/10 text-warning",
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
