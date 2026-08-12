import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface DiffBundleFileSectionFrameProps {
  readonly collapsed: boolean;
  readonly headerRow: ReactNode;
  readonly headerStats: ReactNode | null;
  readonly onOpenFileTile: () => void;
  readonly findFilePath: string;
  readonly bundleFindFileId: string;
  readonly children: ReactNode;
}

const DiffBundleFileHeaderAccessoryContext = createContext<HTMLElement | null>(
  null,
);

export function DiffBundleFileSectionFrame(
  props: DiffBundleFileSectionFrameProps,
): ReactNode {
  const [headerAccessoryTarget, setHeaderAccessoryTarget] =
    useState<HTMLElement | null>(null);
  return (
    <DiffBundleFileHeaderAccessoryContext.Provider
      value={headerAccessoryTarget}
    >
      <div
        className="border-b border-border/70 bg-background"
        data-diff-find-file={props.findFilePath}
        data-bundle-diff-file-id={props.bundleFindFileId}
      >
        <div className="sticky top-0 z-10 flex items-center gap-1 border-b border-border/60 bg-background p-1">
          <div className="min-w-0 flex-1">{props.headerRow}</div>
          <div
            ref={setHeaderAccessoryTarget}
            className="flex min-w-0 shrink-0 items-center gap-1"
            data-testid="bundle-file-header-accessory"
          />
          {props.headerStats}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={props.onOpenFileTile}
            className="h-7 shrink-0 gap-1 px-2 text-ui-xs"
          >
            <ExternalLink className="size-3.5" />
            File
          </Button>
        </div>
        {props.collapsed ? null : props.children}
      </div>
    </DiffBundleFileHeaderAccessoryContext.Provider>
  );
}

export function DiffBundleFileHeaderPortal(props: {
  readonly children: ReactNode;
}): ReactNode {
  const target = useContext(DiffBundleFileHeaderAccessoryContext);
  return target === null ? null : createPortal(props.children, target);
}

export function DiffBundleCollapseChevron(props: {
  readonly collapsed: boolean;
}): ReactNode {
  return (
    <ChevronDown
      className={cn(
        "size-4 shrink-0 text-muted-foreground transition-transform",
        props.collapsed && "-rotate-90",
      )}
    />
  );
}
