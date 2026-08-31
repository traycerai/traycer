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
  /** Placement relative to the trigger. */
  readonly side: "bottom" | "right";
}

/**
 * Hover-tooltip for a (potentially truncated) file path. Renders content
 * via Radix's portal so the trigger's `direction: rtl` (used for left-
 * side ellipsis truncation) doesn't leak into the tooltip's bidi context
 * - Unicode neutrals like `/` would otherwise be reordered into the
 * wrong position.
 *
 * Font-size is delivered through inline `style` rather than a `text-*`
 * className: shadcn's `TooltipContent` already sets `text-ui-xs
 * text-background`, and adding a second `text-*` class would make
 * `tailwind-merge` collapse the group and drop the color, leaving the
 * tooltip invisible against its own background.
 */
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
  return (
    <FilePathTooltip content={props.content} side={props.side}>
      {/* `Slot.Root` nested inside `TooltipTrigger asChild` composes these
          handlers with the child's own instead of replacing them. */}
      <Slot.Root
        {...longPress.handlers}
        onClick={(event) => {
          // The browser still delivers a click after a long press. Here that
          // click reaches the enclosing menu or command item and picks the
          // row - moving the user off the path the press just revealed - so
          // the press that already answered the gesture swallows it.
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
