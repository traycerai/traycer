import { useRef, useState, type ReactNode } from "react";
import { Expand } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useCoarsePointer } from "@/hooks/ui/use-coarse-pointer";

import {
  ArtifactExpandedContext,
  useArtifactExpanded,
} from "./artifact-expanded-context";

/** A preview over the task, leaving the original panel and its view in place. */
export function ArtifactExpandButton(props: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  const expanded = useArtifactExpanded();
  const escapeHandler = useRef<((event: KeyboardEvent) => boolean) | null>(
    null,
  );
  const [open, setOpen] = useState(false);
  const coarsePointer = useCoarsePointer();
  if (expanded) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <TooltipWrapper
        label="Expand"
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <DialogTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size={coarsePointer ? "icon-touch" : "icon-sm"}
            aria-label="Expand"
          >
            <Expand className="size-4" />
          </Button>
        </DialogTrigger>
      </TooltipWrapper>
      <DialogContent
        layout="banded"
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => {
          if (escapeHandler.current?.(event) !== true) return;
          event.preventDefault();
        }}
        onOpenAutoFocus={(event) => {
          if (!(event.target instanceof HTMLElement)) return;
          event.preventDefault();
          event.target
            .querySelector<HTMLButtonElement>("[data-slot=dialog-close]")
            ?.focus();
        }}
        className="flex h-[calc(var(--spacing-safe-dvh)-2rem)] w-[calc(var(--safe-area-width)-2rem)] flex-col overflow-hidden sm:max-w-none"
      >
        <DialogHeader className="shrink-0">
          <DialogTitle size="sm" className="truncate">
            {props.title}
          </DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 pb-safe-bottom">
          <ArtifactExpandedContext.Provider value={escapeHandler}>
            {open ? props.children : null}
          </ArtifactExpandedContext.Provider>
        </div>
      </DialogContent>
    </Dialog>
  );
}
