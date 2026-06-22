import { useMemo } from "react";
import { Maximize2 } from "lucide-react";
import {
  useChatSnapshotDiffOpener,
  type DiffRowClickHandlers,
} from "@/components/chat/chat-diff-target";
import { cn } from "@/lib/utils";

/**
 * Floating "open full diff" affordance for the artifact diff viewer. Opens the
 * merged diff in a canvas tab, mirroring a `file_change` path-click: single
 * click = a non-sticky preview tab (replaced by the next preview), double click
 * = a pinned tab.
 *
 * Positioning: it is rendered INSIDE the card / row's sticky header and pinned
 * to that header's bottom (`top-full`), so it floats at the top-right of the
 * diff just BELOW the header and stays there while a large diff scrolls - both
 * the header and this button pin together, the button always under the header,
 * never overlapping it (no header-height measurement needed).
 *
 * Rendered as a `role="button"` span (not a `<button>`) because the surrounding
 * header is already a `<button>` / CollapsibleTrigger; nesting buttons is
 * invalid HTML. `stopPropagation` keeps clicks off that header trigger. Renders
 * nothing when no chat diff target is in context (isolated render).
 */
export function OpenFullDiffControl(props: {
  readonly filePath: string;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly title: string | null;
}) {
  const opener = useChatSnapshotDiffOpener();
  const handlers = useMemo<DiffRowClickHandlers | null>(
    () =>
      opener === null
        ? null
        : opener.hash({
            filePath: props.filePath,
            beforeHash: props.beforeHash,
            afterHash: props.afterHash,
            title: props.title,
          }),
    [opener, props.filePath, props.beforeHash, props.afterHash, props.title],
  );
  if (handlers === null) return null;
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label="Open full diff"
      title="Open full diff"
      onClick={(event) => {
        event.stopPropagation();
        handlers.onClick();
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        handlers.onDoubleClick();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        handlers.onClick();
      }}
      className={cn(
        "absolute top-full right-2 z-30 mt-2 flex size-7 items-center justify-center",
        // A solid surface so the button reads clearly over diff rows. `--muted`
        // is the distinct neutral (unlike `--popover`/`--card`, which equal
        // `--background` in most themes and so blend into the diff base rows).
        "cursor-pointer rounded-md border border-border bg-muted text-muted-foreground shadow-md",
        "transition-colors hover:bg-accent hover:text-foreground",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
      )}
    >
      <Maximize2 aria-hidden className="size-3.5" />
    </span>
  );
}
