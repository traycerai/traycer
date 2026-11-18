import { cn } from "@/lib/utils";

/**
 * A stable, one-line branch relationship. The branch being created is the
 * primary value; its source remains visible as lower-emphasis provenance.
 * A short target keeps its natural width so the source sits beside it; a long
 * target caps at 60%, leaving the remaining width for source provenance.
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
        "flex min-w-0 flex-1 items-baseline gap-1.5 text-left",
        props.className,
      )}
      data-testid="folder-branch-label"
    >
      <span
        className="max-w-[60%] shrink-0 truncate"
        data-testid="folder-branch-target"
      >
        {props.target}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-ui-xs text-muted-foreground"
        data-testid="folder-branch-source"
      >
        from {props.source}
      </span>
    </span>
  );
}
