import type { ReactNode } from "react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { WorkspaceFolderHoverList } from "./workspace-folder-hover-list";
import type { WorkspaceRunItem } from "./workspace-run-item";

/**
 * The hover preview's content, on the surface a thumb can reach - see
 * `useWorkspaceFolderPreviewReveal`, which owns the press that opens it.
 *
 * The list is rendered unchanged: the point is to reach those facts, not to
 * restate them, so touch and pointer never disagree about what this control
 * says.
 */
export function WorkspaceFolderPreviewSheet(props: {
  readonly items: ReadonlyArray<WorkspaceRunItem>;
  readonly open: boolean;
  readonly onClose: () => void;
}): ReactNode {
  return (
    <Sheet
      open={props.open}
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
    >
      <SheetContent side="bottom" className="gap-0 pb-safe-bottom">
        <SheetTitle className="px-4 pt-4 text-ui-sm">Linked folders</SheetTitle>
        <div className="px-4 pt-2 pb-4">
          <WorkspaceFolderHoverList items={props.items} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
