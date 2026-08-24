import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

export function RefreshIcon(props: {
  readonly refreshing: boolean;
  readonly className?: string;
  readonly testId?: string;
}) {
  return (
    <RefreshCw
      aria-hidden
      className={cn(
        "size-4",
        props.refreshing && "animate-spin",
        props.className,
      )}
      data-testid={props.testId}
    />
  );
}
