import {
  useId,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { useColumnOverlayPlacement } from "@/components/layout/column-edge-context";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { useTitleBarDragSuppression } from "@/stores/layout/title-bar-drag-store";
import { useGroupEditor } from "@/stores/tabs/group-editor-store";
import type { TabGroup } from "@/stores/tabs/tab-groups";
import { TabGroupEditor } from "./tab-group-editor";

/**
 * Puts a tab group's editor on its child, which it anchors to: a right-click
 * opens it, and so do F2, the context-menu key and Shift+F10 while the child
 * itself has focus. A right-click something inside already took (a tile's own
 * menu) is left to it.
 */
export function GroupEditorAnchor(props: {
  readonly groupId: string;
  readonly group: TabGroup;
  readonly onClose: (groupId: string) => void;
  readonly children: ReactElement;
}): ReactNode {
  const { groupId, group } = props;
  const placement = useColumnOverlayPlacement("row");
  const { open, setOpen } = useGroupEditor(groupId);
  // The editor can open over the strip's drag spacer (S-44).
  useTitleBarDragSuppression(`group-editor:${useId()}`, open);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor
        asChild
        onContextMenu={(event) => {
          if (event.defaultPrevented) return;
          event.preventDefault();
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || !opensEditor(event)) {
            return;
          }
          event.preventDefault();
          setOpen(true);
        }}
      >
        {props.children}
      </PopoverAnchor>
      <PopoverContent
        side={placement?.side}
        align={placement?.align ?? "start"}
        className="w-fit max-w-xs"
      >
        <TabGroupEditor
          groupId={groupId}
          group={group}
          onClose={props.onClose}
          onDone={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

function opensEditor(event: KeyboardEvent<HTMLElement>): boolean {
  return (
    event.key === "F2" ||
    event.key === "ContextMenu" ||
    (event.shiftKey && event.key === "F10")
  );
}
