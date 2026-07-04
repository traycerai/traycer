import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { cn } from "@/lib/utils";

export interface WorktreePickerTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly worktreeLabel: string;
  readonly secondaryLabel: string;
  readonly changeCount: number | null;
  readonly trailingStatus: ReactNode | null;
  readonly testId: string | undefined;
  readonly ref?: Ref<HTMLButtonElement>;
}

export function WorktreePickerTrigger(props: WorktreePickerTriggerProps) {
  const {
    worktreeLabel,
    secondaryLabel,
    changeCount,
    trailingStatus,
    testId,
    className,
    ...rest
  } = props;

  return (
    <button
      type="button"
      data-testid={testId}
      className={cn(
        "@container flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md bg-muted/20 px-2 py-1.5 text-left transition-colors hover:bg-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        className,
      )}
      {...rest}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-ui-sm font-medium text-foreground">
          {worktreeLabel}
        </div>
        <StartTruncatedText className="block min-w-0 text-ui-xs text-muted-foreground">
          {secondaryLabel}
        </StartTruncatedText>
      </div>
      {trailingStatus}
      {changeCount !== null ? (
        <Badge
          variant="secondary"
          className="shrink-0 tabular-nums"
          aria-label={`${changeCount} changed`}
        >
          <span aria-hidden>{changeCount}</span>
          <span aria-hidden className="@max-[16rem]:hidden">
            {" "}
            changed
          </span>
        </Badge>
      ) : null}
      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}
