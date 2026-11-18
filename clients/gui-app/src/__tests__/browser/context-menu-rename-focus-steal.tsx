import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useInlineRename } from "@/hooks/ui/use-inline-rename";
import "@/index.css";

/**
 * Real-browser regression: a pointer drift over the still-mounted, exit-
 * animating "Edit Title" `ContextMenuItem` can refocus it and blur-commit
 * `useInlineRename`'s just-mounted input - jsdom has no hit testing or real
 * CSS animation, so this drives the real wrapper + hook in headless Chrome.
 */
const TITLE = "Original title";

export function ContextMenuRenameFocusStealFixture(): React.ReactElement {
  const [title, setTitle] = useState(TITLE);
  const rename = useInlineRename({
    value: title,
    canEdit: true,
    onCommit: setTitle,
  });

  return (
    <div className="p-12">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            data-testid="fixture-trigger"
            className="w-full max-w-sm border border-border p-2"
          >
            {rename.isEditing ? (
              <input
                {...rename.inputProps}
                data-testid="fixture-input"
                aria-label="Edit title"
              />
            ) : (
              <span data-testid="fixture-title">{title}</span>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <ContextMenuItem
            onSelect={rename.startEditing}
            data-testid="fixture-edit-title"
          >
            Edit Title
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}

const container = document.querySelector("#root");
if (container === null) throw new Error("fixture root missing");
createRoot(container).render(<ContextMenuRenameFocusStealFixture />);
