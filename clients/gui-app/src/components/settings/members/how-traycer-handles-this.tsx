import { useState, type ReactNode } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { HOW_TRAYCER_HANDLES_THIS } from "@/components/settings/members/copy";

/**
 * The grant's disclosure. `noticeText` is `dataHandlingNoticeText()`,
 * which reads `DATA_HANDLING_NOTICE` from `@traycer/protocol`.
 */
export function HowTraycerHandlesThis(props: {
  readonly noticeText: string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        variant="quiet"
        className="text-ui-xs"
        data-testid="members-data-handling-trigger"
      >
        {HOW_TRAYCER_HANDLES_THIS}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p
          className="max-w-[72ch] pt-1 text-ui-xs text-muted-foreground"
          data-testid="members-data-handling-notice"
        >
          {props.noticeText}
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}
