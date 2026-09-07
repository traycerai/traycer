import { use } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useEpicViewTabId } from "@/components/epic-canvas/view-tab-context";
import { useManagedCommandOutputDragSource } from "@/components/epic-canvas/dnd/use-managed-command-output-drag-source";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { cn } from "@/lib/utils";

/** The identity a drag needs (epic, bound host, owning canvas view) is read from the same contexts the door
 * hook itself reads; a transcript outside a canvas view simply cannot drag, and still clicks. */
export function ManagedCommandOpenInTabButton(props: {
  readonly commandId: string;
  readonly testId: string;
  readonly onOpen: () => void;
}) {
  const hostId = use(TabHostContext);
  const epicId = useMaybeOpenEpicHandle()?.epicId ?? null;
  const viewTabId = useEpicViewTabId();
  const { isDraggable, setNodeRef, listeners, isDragging } =
    useManagedCommandOutputDragSource({
      epicId,
      viewTabId,
      hostId,
      commandId: props.commandId,
      enabled: true,
    });
  const grabCursor = isDragging ? "cursor-grabbing" : "cursor-grab";
  return (
    <TooltipWrapper
      label="Open in tab"
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <Button
        ref={setNodeRef}
        {...listeners}
        type="button"
        variant="ghost"
        size="icon"
        className={cn(
          "size-6 text-muted-foreground hover:text-foreground",
          isDraggable ? grabCursor : null,
        )}
        aria-label="Open in tab"
        data-testid={props.testId}
        data-draggable={isDraggable ? "true" : "false"}
        // The surrounding header toggles the card; the door is a separate act and must not also fold it. dnd-kit's
        // activation distance means a plain click never becomes a drag, so both gestures share the button.
        onClick={(event) => {
          event.stopPropagation();
          props.onOpen();
        }}
      >
        <ExternalLink aria-hidden className="size-3.5" />
      </Button>
    </TooltipWrapper>
  );
}
