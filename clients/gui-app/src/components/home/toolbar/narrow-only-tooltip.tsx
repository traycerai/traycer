import type { ReactNode } from "react";

import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useIsComposerNarrow } from "@/components/home/composer/composer-narrow-hooks";

interface NarrowOnlyTooltipProps {
  label: ReactNode;
  children: ReactNode;
}

export function NarrowOnlyTooltip(props: NarrowOnlyTooltipProps) {
  const isNarrow = useIsComposerNarrow();
  return (
    <TooltipWrapper
      label={isNarrow ? props.label : null}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      {props.children}
    </TooltipWrapper>
  );
}
