import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Plus, TerminalSquare, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import type { LandingTerminalTabRef } from "@/stores/home/landing-terminal-store";

export interface LandingTerminalTabStripProps {
  readonly tabs: ReadonlyArray<LandingTerminalTabRef>;
  readonly activeInstanceId: string | null;
  readonly canCreate: boolean;
  readonly onAdd: () => void;
  readonly onActivate: (instanceId: string) => void;
  readonly onClose: (tab: LandingTerminalTabRef) => void;
  readonly onRename: (instanceId: string, name: string) => void;
}

/** Presentational, scrollable terminal tab strip mirroring epic tab chrome. */
export function LandingTerminalTabStrip(
  props: LandingTerminalTabStripProps,
): ReactNode {
  const [editingInstanceId, setEditingInstanceId] = useState<string | null>(
    null,
  );
  return (
    <div className="relative flex h-9 shrink-0 items-stretch border-b border-canvas-border/70 bg-canvas">
      <div className="no-scrollbar flex min-w-0 flex-1 items-stretch overflow-x-auto overscroll-x-contain">
        {props.tabs.map((tab) => (
          <LandingTerminalTab
            key={tab.instanceId}
            tab={tab}
            active={tab.instanceId === props.activeInstanceId}
            editing={tab.instanceId === editingInstanceId}
            onActivate={props.onActivate}
            onClose={props.onClose}
            onRename={props.onRename}
            onEdit={() => setEditingInstanceId(tab.instanceId)}
            onEditingComplete={() => setEditingInstanceId(null)}
          />
        ))}
      </div>
      <div className="flex shrink-0 items-center border-l border-canvas-border/70 bg-canvas px-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="New terminal"
          data-testid="landing-terminal-new-tab"
          disabled={!props.canCreate}
          onClick={props.onAdd}
        >
          <Plus className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function LandingTerminalTab(props: {
  readonly tab: LandingTerminalTabRef;
  readonly active: boolean;
  readonly editing: boolean;
  readonly onActivate: (instanceId: string) => void;
  readonly onClose: (tab: LandingTerminalTabRef) => void;
  readonly onRename: (instanceId: string, name: string) => void;
  readonly onEdit: () => void;
  readonly onEditingComplete: () => void;
}): ReactNode {
  const { tab } = props;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="tab"
          aria-selected={props.active}
          tabIndex={0}
          data-testid={`landing-terminal-tab-${tab.instanceId}`}
          onClick={() => props.onActivate(tab.instanceId)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            props.onActivate(tab.instanceId);
          }}
          className={cn(
            "group relative flex min-w-0 shrink-0 items-center gap-1.5 border-r border-canvas-border/70 px-3 text-ui-sm text-muted-foreground outline-hidden transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring",
            "max-w-[45vw]",
            props.active &&
              "bg-(--app-background) text-foreground shadow-[inset_0_-1px_0_var(--color-background)] before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-primary",
          )}
        >
          <TerminalSquare className="size-3.5 shrink-0" aria-hidden="true" />
          {props.editing ? (
            <LandingTerminalRenameInput
              key={tab.name}
              tab={tab}
              onRename={props.onRename}
              onComplete={props.onEditingComplete}
            />
          ) : (
            <span className="truncate">{tab.name}</span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Close ${tab.name}`}
            className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
            onClick={(event) => {
              event.stopPropagation();
              props.onClose(tab);
            }}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={(event) => event.preventDefault()}>
        <ContextMenuItem onSelect={props.onEdit}>Rename</ContextMenuItem>
        <ContextMenuItem onSelect={() => props.onClose(tab)}>
          Close
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function LandingTerminalRenameInput(props: {
  readonly tab: LandingTerminalTabRef;
  readonly onRename: (instanceId: string, name: string) => void;
  readonly onComplete: () => void;
}): ReactNode {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const completeRename = (): void => {
    props.onRename(
      props.tab.instanceId,
      inputRef.current?.value ?? props.tab.name,
    );
    props.onComplete();
  };
  const handleRenameKeyDown = (
    event: KeyboardEvent<HTMLInputElement>,
  ): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      completeRename();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      props.onComplete();
    }
  };

  return (
    <input
      ref={inputRef}
      defaultValue={props.tab.name}
      aria-label="Rename terminal"
      className="min-w-0 flex-1 bg-transparent text-ui-sm outline-hidden"
      onBlur={completeRename}
      onKeyDown={handleRenameKeyDown}
      onClick={(event) => event.stopPropagation()}
    />
  );
}
