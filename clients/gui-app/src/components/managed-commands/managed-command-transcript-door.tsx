import { ExternalLink } from "lucide-react";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { ManagedCommandOpenInTabButton } from "@/components/managed-commands/managed-command-open-in-tab-button";

/** Disabled once the shell is gone rather than hidden: deleting a shell destroys its log with it, so the tab
 * would open onto nothing but a terminal notice. */
export function ManagedCommandTranscriptDoor(props: {
  readonly commandId: string;
  readonly gone: boolean;
  readonly onOpen: ((commandId: string) => void) | null;
  readonly testId: string;
}) {
  const { commandId, gone, onOpen } = props;
  if (gone) {
    return (
      <TooltipWrapper
        label="This shell was deleted"
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        {/* `aria-disabled` rather than `disabled`: a disabled button takes no pointer events and leaves the tab order,
           which would swallow the very tooltip that explains why it cannot be pressed. */}
        <button
          type="button"
          aria-disabled
          aria-label="Open in tab - this shell was deleted"
          data-testid={props.testId}
          className="inline-flex size-6 shrink-0 cursor-default items-center justify-center rounded-md text-muted-foreground/40"
        >
          <ExternalLink aria-hidden className="size-3.5" />
        </button>
      </TooltipWrapper>
    );
  }
  if (onOpen === null) return null;
  return (
    <ManagedCommandOpenInTabButton
      commandId={commandId}
      testId={props.testId}
      onOpen={() => {
        onOpen(commandId);
      }}
    />
  );
}
