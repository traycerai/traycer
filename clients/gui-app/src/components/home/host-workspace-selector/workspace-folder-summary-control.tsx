import { useRef, useState } from "react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { preserveWhenNestedOverlay } from "./preserve-when-nested-overlay";
import { useDialogOverlayBoundaryEl } from "@/providers/dialog-overlay-boundary-context";
import {
  AddFolderButton,
  type AddFolderHandler,
  WorkspaceFolderRows,
} from "./workspace-folder-rows";
import { WorkspaceFolderHoverList } from "./workspace-folder-hover-list";
import { WorkspaceSummaryTrigger } from "./workspace-summary-trigger";
import type { WorkspaceRunItem } from "./workspace-run-item";

interface SummaryOverlayState {
  readonly workspacePopoverOpen: boolean;
  readonly summaryHoverOpen: boolean;
}

/**
 * Resting folder control shared by landing and in-epic composers. It is the
 * single owner of the empty-state shortcut: resolved + no folders renders
 * "Add folder" directly instead of a "No workspace linked" summary popover.
 */
export function WorkspaceFolderSummaryControl(props: {
  readonly items: ReadonlyArray<WorkspaceRunItem>;
  readonly readOnly: boolean;
  readonly bindingResolved: boolean;
  readonly addFolderPending: boolean;
  readonly addFolderDisabled: boolean;
  readonly addFolderDisabledReason: string | null;
  readonly onAddFolder: AddFolderHandler;
  readonly onUpdate: (() => void) | null;
  readonly updateEnabled: boolean;
  readonly updatePending: boolean;
  readonly onDiscardStaged: (() => void) | null;
  readonly onEditEnvironment: (workspacePath: string) => void;
  readonly hoverPreviewEnabled: boolean;
  readonly popoverTestId: string;
  readonly popoverSide: "top" | "bottom";
}) {
  const itemCount = props.items.length;
  const [overlayState, setOverlayState] = useState<SummaryOverlayState>({
    workspacePopoverOpen: false,
    summaryHoverOpen: false,
  });
  // The popover's own content node, so an outside-click can tell a nested
  // overlay (stacked above) from the host dialog (an ancestor) - see
  // preserveWhenNestedOverlay.
  const contentRef = useRef<HTMLDivElement>(null);
  // Non-null only inside a modal dialog (the New Conversation modal) - see
  // `DialogOverlayBoundaryContext`. Containing this popover inside the
  // dialog's own DOM (instead of the default `document.body` portal) keeps it
  // - and the branch/location popovers nested inside it - within the
  // dialog's scroll-lock boundary, so wheel scrolling their lists works.
  const dialogBoundaryEl = useDialogOverlayBoundaryEl();

  const handleExternalAddFolder = async (): Promise<boolean> => {
    setOverlayState({
      workspacePopoverOpen: true,
      summaryHoverOpen: false,
    });
    try {
      const added = await props.onAddFolder();
      if (!added) {
        setOverlayState((current) => ({
          ...current,
          workspacePopoverOpen: false,
        }));
      }
      return added;
    } catch {
      setOverlayState((current) => ({
        ...current,
        workspacePopoverOpen: false,
      }));
      return false;
    }
  };
  const handleUpdate = (): void => {
    if (props.onUpdate === null) return;
    props.onUpdate();
    setOverlayState({
      workspacePopoverOpen: false,
      summaryHoverOpen: false,
    });
  };

  if (props.readOnly) {
    return (
      <WorkspaceSummaryTrigger
        items={props.items}
        readOnly
        bindingResolved={props.bindingResolved}
        className="max-w-full"
      />
    );
  }

  if (itemCount === 0 && props.bindingResolved) {
    return (
      <AddFolderButton
        onAddFolder={handleExternalAddFolder}
        pending={props.addFolderPending}
        disabled={props.addFolderDisabled}
        disabledReason={props.addFolderDisabledReason}
      />
    );
  }

  const trigger = (
    <WorkspaceSummaryTrigger
      items={props.items}
      readOnly={false}
      bindingResolved={props.bindingResolved}
      className="justify-start overflow-hidden"
    />
  );
  const popoverTrigger = props.hoverPreviewEnabled ? (
    <HoverCard
      open={!overlayState.workspacePopoverOpen && overlayState.summaryHoverOpen}
      onOpenChange={(open) => {
        setOverlayState((current) => {
          if (current.workspacePopoverOpen) return current;
          return { ...current, summaryHoverOpen: open };
        });
      }}
      openDelay={350}
      closeDelay={120}
    >
      <HoverCardTrigger asChild>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      </HoverCardTrigger>
      <HoverCardContent
        side={props.popoverSide}
        align="start"
        className="w-[min(92vw,24rem)] rounded-md bg-foreground p-0 text-ui-xs text-background"
      >
        <WorkspaceFolderHoverList items={props.items} />
      </HoverCardContent>
    </HoverCard>
  ) : (
    <PopoverTrigger asChild>{trigger}</PopoverTrigger>
  );

  return (
    <Popover
      open={overlayState.workspacePopoverOpen}
      onOpenChange={(open) => {
        setOverlayState((current) => ({
          workspacePopoverOpen: open,
          summaryHoverOpen: open ? false : current.summaryHoverOpen,
        }));
        if (!open && props.onDiscardStaged !== null) {
          props.onDiscardStaged();
        }
      }}
    >
      {popoverTrigger}
      <PopoverContent
        ref={contentRef}
        side={props.popoverSide}
        align="start"
        collisionPadding={12}
        container={dialogBoundaryEl ?? undefined}
        className="w-fit max-w-[min(92vw,40rem)] max-h-[min(var(--radix-popover-content-available-height),32rem)] gap-0 overflow-y-auto p-3"
        data-testid={props.popoverTestId}
        onInteractOutside={(event) =>
          preserveWhenNestedOverlay(event, contentRef.current)
        }
      >
        <WorkspaceFolderRows
          items={props.items}
          trailingSlot={null}
          addFolderPending={props.addFolderPending}
          addFolderDisabled={props.addFolderDisabled}
          addFolderDisabledReason={props.addFolderDisabledReason}
          onAddFolder={props.onAddFolder}
          onUpdate={props.onUpdate === null ? null : handleUpdate}
          updateEnabled={props.updateEnabled}
          updatePending={props.updatePending}
          onEditEnvironment={props.onEditEnvironment}
          readOnly={false}
          nestedInPopover={dialogBoundaryEl !== null}
          bindingResolved={props.bindingResolved}
        />
      </PopoverContent>
    </Popover>
  );
}
