import {
  createContext,
  useCallback,
  useContext,
  useState,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { useRender } from "@base-ui/react/use-render";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { FullPathSheet } from "@/components/folder-picker-path-view";
import { useLongPress } from "@/hooks/ui/use-long-press";

interface FilePathTooltipProps {
  /** The trigger element (typically a truncated path span). Must accept a
   * forwarded ref since `TooltipTrigger render` clones the child. */
  readonly children: ReactElement;
  /** Full text to display in the tooltip - usually the un-truncated path,
   * but any string works (e.g., `"Open <path> in editor"`). */
  readonly content: string;
  /** Placement relative to the trigger. */
  readonly side: "bottom" | "right";
}

/**
 * Hover-tooltip for a (potentially truncated) file path. Renders content
 * via the tooltip portal so the trigger's `direction: rtl` (used for left-
 * side ellipsis truncation) doesn't leak into the tooltip's bidi context
 * - Unicode neutrals like `/` would otherwise be reordered into the
 * wrong position.
 *
 * The type is `TooltipContent`'s own; only the FACE is set here, because
 * whether a label is a path is a fact about what is being labelled. The note
 * that used to sit here - that a second `text-*` class would collapse the
 * group and drop the tooltip's color - stopped being true when `cn.config.mjs`
 * registered the custom `--text-*` tokens as font sizes.
 */
export function FilePathTooltip(props: FilePathTooltipProps) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.children} />
      <TooltipContent
        side={props.side}
        align="start"
        className="max-w-md font-mono wrap-anywhere"
      >
        {props.content}
      </TooltipContent>
    </Tooltip>
  );
}

const FilePathRevealContext = createContext<((path: string) => void) | null>(
  null,
);

/**
 * Owns the reveal sheet on behalf of the rows beneath it, and must wrap them
 * rather than sit inside one.
 *
 * A Radix portal is DOM-detached but React-ATTACHED: the sheet's markup goes to
 * the body, yet React propagates events through the React TREE. A sheet
 * rendered by a row therefore bubbles its clicks back into that row - a
 * `CommandItem` or `DropdownMenuItem` whose click launches a terminal or adopts
 * a worktree - so dismissing the sheet picked the very row the press was only
 * inspecting. Stopping propagation at the sheet was tried and is not enough:
 * the overlay is a sibling of the content inside the same portal, so each
 * surface has to be found and covered one at a time, and the next one added
 * would silently reopen the hole. Hoisting the sheet out of every row's subtree
 * removes the class instead of patching its instances.
 */
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

/**
 * {@link FilePathTooltip} plus the touch half of the same disclosure: a long
 * press carries the identical string into the full-path sheet, the way an
 * abbreviated row in the remote folder picker does. Hover and press reveal one
 * string, so a truncated path is never a pointer-only fact.
 *
 * The press lives on the path line rather than on the row around it. Rows that
 * carry a truncated path routinely disable themselves - a launch in flight, a
 * worktree that is still `checking` - and a disabled row takes
 * `pointer-events-none` for its whole box, so a row-level recognizer would go
 * dead on exactly the row whose location someone most wants to read. Those
 * lines already re-open that one hole with `pointer-events-auto`; this hangs
 * off the same element.
 *
 * The sheet itself belongs to {@link FilePathRevealProvider}, which must wrap
 * the rows - see there for why a row cannot own it.
 *
 * A row that wires its own long press (the remote picker's, which spans the
 * whole row because nothing there disables) keeps using {@link FilePathTooltip}
 * directly - two recognizers over one gesture would open two sheets.
 */
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
  const trigger = useRender({
    render: props.children,
    props: {
      ...longPress.handlers,
      onClick: (event: MouseEvent<HTMLElement>) => {
        // The click after a consumed hold must not activate the enclosing row.
        if (!longPress.consumedTap()) return;
        event.preventDefault();
        event.stopPropagation();
      },
    },
  });
  return (
    <FilePathTooltip content={props.content} side={props.side}>
      {trigger}
    </FilePathTooltip>
  );
}
