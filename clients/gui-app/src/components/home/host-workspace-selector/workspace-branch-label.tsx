import { cn } from "@/lib/utils";

/**
 * A stable, one-line branch relationship. The branch being created is the
 * primary value; its source remains visible as lower-emphasis provenance.
 * Each side truncates independently so a long value cannot evict the other.
 */
export function WorkspaceBranchLabel(props: {
  readonly target: string;
  readonly source: string | null;
  readonly className: string | undefined;
}) {
  if (props.source === null) {
    return (
      <span
        className={cn("min-w-0 flex-1 truncate text-left", props.className)}
        data-testid="folder-branch-label"
      >
        {props.target}
      </span>
    );
  }

  return (
    <span
      className={cn(
        "grid min-w-0 flex-1 grid-cols-[minmax(0,3fr)_minmax(3rem,2fr)] items-baseline gap-1.5 text-left",
        props.className,
      )}
      data-testid="folder-branch-label"
    >
      <span className="truncate" data-testid="folder-branch-target">
        {props.target}
      </span>
      <span
        className="truncate text-ui-xs text-muted-foreground"
        data-testid="folder-branch-source"
      >
        from {props.source}
      </span>
    </span>
  );
}
