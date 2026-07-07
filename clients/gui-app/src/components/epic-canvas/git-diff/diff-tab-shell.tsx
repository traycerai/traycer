import type { ReactNode } from "react";
import { FileDiff } from "lucide-react";

interface DiffTabShellProps {
  readonly primaryTitle: string;
  readonly secondaryLine: ReactNode | null;
  readonly contextLabel: string | null;
  readonly toolbar: ReactNode;
  readonly children: ReactNode;
}

export function DiffTabShell(props: DiffTabShellProps) {
  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      <div className="z-10 flex min-h-[clamp(2.5rem,5dvh,3rem)] shrink-0 items-center justify-between gap-3 border-b border-border/70 bg-background px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <FileDiff className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <h2 className="truncate text-ui-sm font-medium">
              {props.primaryTitle}
            </h2>
            {props.secondaryLine !== null ? (
              <div className="truncate text-ui-xs text-muted-foreground">
                {props.secondaryLine}
              </div>
            ) : null}
            {props.contextLabel !== null ? (
              <div className="truncate text-ui-xs text-muted-foreground/80">
                {props.contextLabel}
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">{props.toolbar}</div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {props.children}
      </div>
    </div>
  );
}

export function GitSectionStatsSummary(props: {
  readonly insertions: number;
  readonly deletions: number;
}): ReactNode {
  if (props.insertions === 0 && props.deletions === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-0.5 whitespace-nowrap px-1 py-0.5 text-ui-xs tabular-nums">
      <span className="font-medium text-emerald-600 dark:text-emerald-400">
        +{props.insertions}
      </span>
      <span className="font-medium text-red-600 dark:text-red-400">
        -{props.deletions}
      </span>
    </span>
  );
}
