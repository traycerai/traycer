import { useMemo, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useOpenEpicFileTile } from "@/hooks/files/use-open-epic-file-tile";
import { useMaybeEpicFiles } from "@/hooks/files/use-epic-file-record";
import { epicFileVersionChain } from "@/lib/files/epic-files-model";
import { formatCompactRelativeTime, useSampledNow } from "@/lib/relative-time";

export interface EpicFileVersionNavProps {
  readonly epicId: string;
  readonly hostId: string;
  /** The version this tile is showing. */
  readonly path: string;
}

/**
 * The tile bar's "Version 2 of 2" pill (FileTile): a menu over the versions of
 * an edited page, oldest first, that opens the one picked in its own tile.
 * Renders nothing for a file with a single version, so an unedited file's bar
 * is exactly what T06 shipped.
 */
export function EpicFileVersionNav(props: EpicFileVersionNavProps): ReactNode {
  const files = useMaybeEpicFiles();
  const now = useSampledNow();
  const openTile = useOpenEpicFileTile(props.epicId, props.hostId);
  const chain = useMemo(
    () => epicFileVersionChain(files.records, props.path),
    [files.records, props.path],
  );
  if (chain.length < 2) return null;
  const position = chain.findIndex((record) => record.path === props.path) + 1;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="epic-file-version-nav"
          className="inline-flex h-5.5 shrink-0 items-center gap-1 rounded-full border border-border px-2 text-ui-xs text-muted-foreground hover:text-foreground"
        >
          Version {position} of {chain.length}
          <ChevronDown className="size-3" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {chain
          .map((record, index) => ({ record, number: index + 1 }))
          .reverse()
          .map(({ record, number }) => (
            <DropdownMenuItem
              key={record.path}
              onSelect={() =>
                openTile({ path: record.path, sha256: record.entry.sha256 })
              }
            >
              <span className="flex-1">
                Version {number}
                {number === chain.length ? " (latest)" : ""}
              </span>
              <span className="text-ui-xs text-muted-foreground">
                {formatCompactRelativeTime(record.entry.createdAt, now)}
              </span>
              {record.path === props.path ? (
                <Check className="size-3.5" aria-hidden />
              ) : null}
            </DropdownMenuItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
