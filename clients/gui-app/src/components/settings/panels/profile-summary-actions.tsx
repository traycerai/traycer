import type { ReactNode } from "react";
import { Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";

export function ProfileSummaryActions(props: {
  readonly children: ReactNode;
  readonly onManage: (() => void) | null;
  readonly managementHeldReason: string | null;
  readonly manageHint: string;
}): ReactNode {
  return (
    <div
      data-slot="profile-summary-actions"
      // Wraps because every item except the email is a fixed-width chip:
      // in a single-line row a narrow viewport collapses the email to
      // nothing and then pushes the chips into one another, since none of
      // them can shrink. Wrapping drops the buttons onto their own line
      // instead, keeping every chip whole.
      className="flex min-w-0 flex-wrap items-center justify-end gap-2"
    >
      {props.children}
      {props.onManage === null ? null : (
        <TooltipWrapper
          label={props.managementHeldReason ?? props.manageHint}
          side="bottom"
          sideOffset={6}
          align="end"
        >
          {/* A disabled button emits no pointer events for the tooltip to
              see, so the tooltip wraps a span. */}
          <span className="inline-flex">
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="shrink-0"
              disabled={props.managementHeldReason !== null}
              onClick={props.onManage}
            >
              <Settings2 data-icon="inline-start" />
              Manage profile
            </Button>
          </span>
        </TooltipWrapper>
      )}
    </div>
  );
}
