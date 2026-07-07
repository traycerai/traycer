import type { ReactNode } from "react";
import { SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface NoMatchingFilesProps {
  readonly query: string;
  readonly onClear: () => void;
}

/**
 * Shown in place of the file list when an active filter matches no changed
 * files in either layout. The search input and repo switcher stay mounted
 * above this, so clearing the filter restores the full list.
 */
export function NoMatchingFiles(props: NoMatchingFilesProps): ReactNode {
  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col items-center justify-center gap-3 text-center",
        "px-4 py-8",
      )}
      data-testid="git-no-matching-files"
    >
      <SearchX className="size-8 text-muted-foreground" />
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">
          No changed files match
        </p>
        <p className="min-w-0 truncate text-xs text-muted-foreground">
          “{props.query}”
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={props.onClear}
        className="mt-2"
      >
        Clear filter
      </Button>
    </div>
  );
}
