import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface TreeChevronProps {
  expanded: boolean;
  onToggle: ((event: React.MouseEvent<HTMLSpanElement>) => void) | undefined;
}

export function TreeChevron(props: TreeChevronProps) {
  const { expanded, onToggle } = props;
  return (
    <span
      aria-hidden="true"
      onClick={onToggle}
      className={cn(
        "-mx-0.5 inline-flex size-3 shrink-0 cursor-pointer items-center justify-center text-muted-foreground/70 transition-transform",
        expanded && "rotate-90",
      )}
    >
      <ChevronRight className="size-3" />
    </span>
  );
}

/** Mirrors TreeChevron's box geometry exactly so the column can't drift. */
export function TreeChevronSpacer() {
  return (
    <span aria-hidden="true" className="-mx-0.5 inline-flex size-3 shrink-0" />
  );
}
