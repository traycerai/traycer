import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Slot } from "radix-ui";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { FullPathSheet } from "@/components/folder-picker-path-view";
import { useLongPress } from "@/hooks/ui/use-long-press";

interface FilePathTooltipProps {
  /** The trigger element (typically a truncated path span). Must accept a
   * forwarded ref since `TooltipTrigger asChild` clones the child. */
  readonly children: ReactElement;
  /** Full text to display in the tooltip - usually the un-truncated path,
   * but any string works (e.g., `"Open <path> in editor"`). */
  readonly content: string;
  readonly side: "bottom" | "right";
}

/** Font-size is delivered through inline `style` rather than a `text-*` className. */
export function FilePathTooltip(props: FilePathTooltipProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{props.children}</TooltipTrigger>
      <TooltipContent
        side={props.side}
        align="start"
        className="max-w-md px-2 py-1 font-mono"
        style={{
          fontSize: "var(--text-code-xs)",
          overflowWrap: "anywhere",
        }}
      >
        {props.content}
      </TooltipContent>
    </Tooltip>
  );
}

const FilePathRevealContext = createContext<((path: string) => void) | null>(
  null,
);

/** Owns the reveal sheet on behalf of the rows beneath it, and must wrap them rather than sit inside one. */
export function FilePathRevealProvider(props: {
  readonly children: ReactNode;
}): ReactNode {
  const [revealed, setRevealed] = useState<string | null>(null);
  const reveal = useCallback((path: string) => setRevealed(path), []);
  return (
    <FilePathRevealContext.Provider value={reveal}>
      {props.children}
      <FullPathSheet path={revealed} onClose={() => setRevealed(null)} />
    </FilePathRevealContext.Provider>
  );
}

/** Hover and press reveal one string, so a truncated path is never a pointer-only fact. The sheet itself
 * belongs to FilePathRevealProvider, which must wrap the rows - see there for why a row cannot own it. */
export function FilePathReveal(props: FilePathTooltipProps): ReactNode {
  const reveal = useContext(FilePathRevealContext);
  const longPress = useLongPress({
    // Loud rather than silently hover-only: without a provider the touch route
    // would just quietly not exist, on the surfaces it was added for.
    onLongPress: () => {
      if (reveal === null) {
        throw new Error("FilePathReveal needs a FilePathRevealProvider");
      }
      reveal(props.content);
    },
    disabled: false,
  });
  return (
    <FilePathTooltip content={props.content} side={props.side}>
      {/* `Slot.Root` nested inside `TooltipTrigger asChild` composes these
          handlers with the child's own instead of replacing them. */}
      <Slot.Root
        {...longPress.handlers}
        onClick={(event) => {
          // The browser still delivers a click after a long press.
          if (!longPress.consumedTap()) return;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {props.children}
      </Slot.Root>
    </FilePathTooltip>
  );
}
