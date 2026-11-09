import { type ReactNode } from "react";
import { Expand } from "lucide-react";

import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useCoarsePointer } from "@/hooks/ui/use-coarse-pointer";

import {
  EXPAND_TOGGLE_ATTRIBUTE,
  useArtifactExpansion,
} from "./artifact-expanded-context";

/**
 * Raises the surface this control sits in over the task
 * (`artifact-expansion.tsx`), and stands down while it is raised - the surface
 * has a Close of its own then, and this button rides up with it.
 *
 * Nothing is rendered without an expansion above, so a surface shown somewhere
 * that cannot raise one has no dead control.
 */
export function ArtifactExpandButton(): ReactNode {
  const expansion = useArtifactExpansion();
  const coarsePointer = useCoarsePointer();
  if (expansion === null || expansion.expanded) return null;
  return (
    <TooltipWrapper
      label="Expand"
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <Button
        {...{ [EXPAND_TOGGLE_ATTRIBUTE]: "" }}
        type="button"
        variant="ghost"
        size={coarsePointer ? "icon-touch" : "icon-sm"}
        aria-label="Expand"
        onClick={() => expansion.expand()}
      >
        <Expand className="size-4" />
      </Button>
    </TooltipWrapper>
  );
}
