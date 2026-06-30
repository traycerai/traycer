import { useState } from "react";
import {
  Bot,
  ChevronDown,
  Monitor,
  Square,
  TerminalSquare,
} from "lucide-react";
import type { BackgroundItem } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { LivePulse } from "@/components/ui/live-pulse";
import { cn } from "@/lib/utils";

function backgroundKindLabel(kind: BackgroundItem["kind"]): string {
  if (kind === "subagent") return "Agent";
  if (kind === "monitor") return "Monitor";
  return "Command";
}

function BackgroundKindIcon(props: { readonly kind: BackgroundItem["kind"] }) {
  if (props.kind === "subagent") {
    return <Bot aria-hidden className="size-3.5 shrink-0 text-primary/80" />;
  }
  if (props.kind === "monitor") {
    return (
      <Monitor aria-hidden className="size-3.5 shrink-0 text-primary/80" />
    );
  }
  return (
    <TerminalSquare aria-hidden className="size-3.5 shrink-0 text-primary/80" />
  );
}

function BackgroundStopButton(props: {
  readonly label: string;
  readonly iconOnly: boolean;
  readonly disabled: boolean;
  readonly testId: string | undefined;
  readonly onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="shrink-0"
      disabled={props.disabled}
      aria-label={props.iconOnly ? props.label : undefined}
      title={props.iconOnly ? props.label : undefined}
      data-testid={props.testId}
      onClick={(event) => {
        event.stopPropagation();
        props.onClick();
      }}
    >
      <Square aria-hidden className="size-3" />
      {props.iconOnly ? null : props.label}
    </Button>
  );
}

// Collapse the host list to one row per task id. The host broadcasts a
// running-only list and removes an item atomically at its terminal, so this is
// a defensive guard: a transient duplicate (same `taskId`) must not render two
// rows with the same React key or two stop affordances for one task.
function dedupeByTaskId(
  items: ReadonlyArray<BackgroundItem>,
): ReadonlyArray<BackgroundItem> {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.taskId)) return false;
    seen.add(item.taskId);
    return true;
  });
}

export function BackgroundItemsPanel(props: {
  readonly items: ReadonlyArray<BackgroundItem>;
  readonly canAct: boolean;
  readonly readOnly: boolean;
  readonly pendingStopTaskIds: ReadonlySet<string>;
  readonly stopAllPending: boolean;
  readonly scrollRegionMaxHeightClass: string;
  readonly separated: boolean;
  readonly onItemClick: (item: BackgroundItem) => void;
  readonly onStopItem: (taskId: string) => string | null;
  readonly onStopAll: () => string | null;
}) {
  const [open, setOpen] = useState(false);
  const stoppable = props.canAct && !props.readOnly;
  const items = dedupeByTaskId(props.items);
  const stopAllDisabled = !stoppable || props.stopAllPending;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "bg-muted/30",
        props.separated ? "border-t border-border/50" : null,
      )}
      data-testid="background-items-panel"
    >
      <div className="flex items-stretch">
        <CollapsibleTrigger className="group/background flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <ChevronDown
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-muted-foreground/70 transition-transform",
              open ? null : "-rotate-90",
            )}
          />
          <LivePulse
            size="xs"
            tone="active"
            ariaLabel="Background items running"
            className={undefined}
          />
          <span className="shrink-0 text-ui-xs font-medium text-foreground/85">
            Background
          </span>
          <span aria-hidden className="shrink-0 text-muted-foreground/40">
            ·
          </span>
          <span className="min-w-0 flex-1 truncate text-ui-xs text-muted-foreground">
            {items.length} running
          </span>
        </CollapsibleTrigger>
        <div className="flex shrink-0 items-center gap-1 pr-1.5">
          <BackgroundStopButton
            label="Stop all"
            iconOnly={false}
            disabled={stopAllDisabled}
            testId="background-stop-all"
            onClick={props.onStopAll}
          />
        </div>
      </div>
      <CollapsibleContent>
        <div
          data-testid="background-items-list"
          className={cn(
            "overflow-y-auto border-t border-border/50 chat-scrollbar-native-thin",
            props.scrollRegionMaxHeightClass,
          )}
        >
          <ul className="m-0 flex list-none flex-col gap-0.5 p-1.5">
            {items.map((item) => (
              <li
                key={item.taskId}
                className="group flex min-w-0 items-center gap-2 rounded-md px-2 hover:bg-muted/40"
              >
                <button
                  type="button"
                  title={item.title}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md py-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  onClick={() => props.onItemClick(item)}
                >
                  <BackgroundKindIcon kind={item.kind} />
                  <span className="block min-w-0 flex-1 truncate text-ui-xs text-foreground/85">
                    {item.title}
                  </span>
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-ui-xs uppercase text-muted-foreground">
                    {backgroundKindLabel(item.kind)}
                  </span>
                </button>
                <span className="inline-flex opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <BackgroundStopButton
                    label={`Stop ${backgroundKindLabel(item.kind)}`}
                    iconOnly
                    disabled={
                      !stoppable || props.pendingStopTaskIds.has(item.taskId)
                    }
                    testId={undefined}
                    onClick={() => props.onStopItem(item.taskId)}
                  />
                </span>
              </li>
            ))}
          </ul>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
