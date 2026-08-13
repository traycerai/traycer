import type { ReactNode } from "react";
import { Code2Icon, ImageIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";

/** Per-tile SVG source/image toggle, shared by the workspace file tile and the git diff tile. */
export function SvgViewToggleButton(props: {
  readonly switchTo: "image" | "source";
  readonly onClick: () => void;
}): ReactNode {
  const label = props.switchTo === "image" ? "View image" : "View source";
  return (
    <TooltipWrapper
      label={label}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={props.onClick}
        aria-label={label}
      >
        {props.switchTo === "image" ? (
          <ImageIcon className="size-4" />
        ) : (
          <Code2Icon className="size-4" />
        )}
      </Button>
    </TooltipWrapper>
  );
}
