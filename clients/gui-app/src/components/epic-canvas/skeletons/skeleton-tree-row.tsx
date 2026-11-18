import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface SkeletonTreeRowProps {
  readonly depth: number;
  readonly labelWidth: string;
}

export function SkeletonTreeRow(props: SkeletonTreeRowProps) {
  const indentEm = 0.5 + props.depth;
  return (
    <div
      className="flex h-9 items-center gap-1.5 rounded-md pr-2 text-ui-sm"
      style={{ paddingInlineStart: `${indentEm}rem` }}
    >
      <Skeleton className="size-3.5 shrink-0 rounded-sm" />
      <Skeleton className={cn("h-3 rounded", props.labelWidth)} />
    </div>
  );
}
