import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";

export function FilterSection(props: {
  readonly label: string;
  readonly trailing: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 px-1">
        <p className="text-overline font-medium uppercase text-muted-foreground/70">
          {props.label}
        </p>
        {props.trailing}
      </div>
      <div className="flex flex-col gap-0.5">{props.children}</div>
    </section>
  );
}

export function FilterOption(props: {
  readonly label: string;
  readonly truncateLabelFromStart: boolean;
  readonly count: number | undefined;
  readonly checked: boolean;
  readonly onToggle: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={props.checked}
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-ui-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50",
        props.checked && "bg-accent/60",
      )}
      onClick={props.onToggle}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-sm border border-input text-primary-foreground",
          props.checked && "border-primary bg-primary",
        )}
      >
        {props.checked ? <Check className="size-3" /> : null}
      </span>
      {props.truncateLabelFromStart ? (
        <TooltipWrapper
          label={props.label}
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <StartTruncatedText className="min-w-0 flex-1">
            {props.label}
          </StartTruncatedText>
        </TooltipWrapper>
      ) : (
        <span className="min-w-0 flex-1 truncate">{props.label}</span>
      )}
      {props.count === undefined ? null : (
        <span className="shrink-0 text-ui-xs text-muted-foreground">
          {props.count}
        </span>
      )}
    </button>
  );
}
