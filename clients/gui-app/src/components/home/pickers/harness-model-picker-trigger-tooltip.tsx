import { useState, type ReactNode } from "react";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";

interface HarnessModelPickerTriggerTooltipProps {
  readonly children: ReactNode;
  readonly label: ReactNode;
  readonly pickerOpen: boolean;
}

/** Keep the model hint out of the picker and reset it before focus returns. */
export function HarnessModelPickerTriggerTooltip(
  props: HarnessModelPickerTriggerTooltipProps,
) {
  const { children, label, pickerOpen, ...triggerProps } = props;
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const [previousPickerOpen, setPreviousPickerOpen] = useState(pickerOpen);

  // Clear hover state in the same update that opens the picker. The tooltip
  // trigger stays mounted, so the popover keeps its anchor and focus.
  if (pickerOpen !== previousPickerOpen) {
    setPreviousPickerOpen(pickerOpen);
    if (pickerOpen) setTooltipOpen(false);
  }

  return (
    <TooltipWrapper
      {...triggerProps}
      label={label}
      open={pickerOpen ? false : tooltipOpen}
      onOpenChange={(open) => {
        if (!pickerOpen) setTooltipOpen(open);
      }}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      {children}
    </TooltipWrapper>
  );
}
