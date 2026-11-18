import { FileXIcon } from "lucide-react";

interface MissingFilePlaceholderProps {
  readonly fileName: string;
}

/**
 * A preview tile whose file is gone from disk, typically deleted or moved
 * while its tab stayed open. Kept apart from `BinaryPlaceholder` on purpose:
 * that layout names the file's type and offers Open Externally, and neither
 * holds for a file that no longer exists. There is no retry action either,
 * because the tile already checks the file again each time its pane regains
 * focus.
 */
export function MissingFilePlaceholder(props: MissingFilePlaceholderProps) {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-4 p-8 text-center">
      <FileXIcon className="size-12 text-muted-foreground" />
      <h3 className="text-base font-semibold">File not found</h3>
      <p className="text-sm text-muted-foreground">{props.fileName}</p>
      <p className="text-xs text-muted-foreground">
        It may have been moved, renamed or deleted.
      </p>
    </div>
  );
}
