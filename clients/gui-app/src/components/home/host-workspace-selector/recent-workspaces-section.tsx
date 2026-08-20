import { useRef, useState, type ReactNode } from "react";
import { ChevronRight, Folder, Search, Trash2 } from "lucide-react";
import type { WorkspaceRecentEntry } from "@traycer/protocol/host/workspace/unary-schemas";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { workspaceFolderName } from "@/lib/worktree/workspace-folder-name";
import type { RecentWorkspacesController } from "./use-recent-workspaces";

export function RecentWorkspacesSection(props: {
  readonly entries: readonly WorkspaceRecentEntry[];
  readonly activeCount: number;
  readonly pendingPath: string | null;
  readonly failedPaths: ReadonlySet<string>;
  readonly onAdd: RecentWorkspacesController["add"];
  readonly onLocate: RecentWorkspacesController["locate"];
  readonly onForget: RecentWorkspacesController["forget"];
}) {
  const empty = props.entries.length === 0;
  const [open, setOpen] = useState(props.activeCount === 0);
  const sectionRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  if (empty && props.activeCount === 0) return null;

  const restoreFocusAfterRemoval = (previousIndex: number): void => {
    const fallbackRoot = sectionRef.current?.parentElement ?? null;
    window.requestAnimationFrame(() => {
      const actions = sectionRef.current?.querySelectorAll<HTMLButtonElement>(
        "[data-recent-primary-action]",
      );
      if (actions !== undefined && actions.length > 0) {
        const next = actions.item(Math.min(previousIndex, actions.length - 1));
        next.focus();
        return;
      }
      if (triggerRef.current !== null) {
        triggerRef.current.focus();
      } else {
        fallbackRoot
          ?.querySelector<HTMLButtonElement>("[data-testid=folder-add]")
          ?.focus();
      }
    });
  };

  return (
    <Collapsible
      className="contents"
      open={!empty && open}
      onOpenChange={(nextOpen) => {
        if (!empty) setOpen(nextOpen);
      }}
    >
      <CollapsibleTrigger asChild>
        <TooltipWrapper
          label={empty ? "No recent folders" : null}
          side="top"
          sideOffset={4}
          align="center"
        >
          <button
            ref={triggerRef}
            type="button"
            aria-disabled={empty}
            aria-label={`Recent folders, ${props.entries.length}`}
            className="ms-auto inline-flex w-fit min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-ui-sm text-muted-foreground outline-none transition-[background-color,color] hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground [&[data-state=open]>svg]:rotate-90"
          >
            <ChevronRight
              className="size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none"
              aria-hidden
            />
            <span className="truncate">Recent</span>
            <span
              key={props.entries.length}
              className="rounded-md bg-foreground/6 px-1.5 tabular-nums text-ui-xs text-muted-foreground motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95"
              aria-hidden
            >
              {props.entries.length}
            </span>
          </button>
        </TooltipWrapper>
      </CollapsibleTrigger>
      <CollapsibleContent ref={sectionRef} className="min-w-0 basis-full">
        <div className="flex min-w-0 flex-col gap-1 pt-1">
          {props.entries.map((entry, index) => (
            <RecentWorkspaceRow
              key={entry.path}
              entry={entry}
              pendingPath={props.pendingPath}
              failed={props.failedPaths.has(entry.path)}
              onAdd={async () => {
                if (await props.onAdd(entry.path)) {
                  restoreFocusAfterRemoval(index);
                }
              }}
              onLocate={async () => {
                if (await props.onLocate(entry.path)) {
                  restoreFocusAfterRemoval(index);
                }
              }}
              onForget={async () => {
                const result = props.onForget(entry.path);
                restoreFocusAfterRemoval(index);
                await result;
              }}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function RecentWorkspaceRow(props: {
  readonly entry: WorkspaceRecentEntry;
  readonly pendingPath: string | null;
  readonly failed: boolean;
  readonly onAdd: () => Promise<void>;
  readonly onLocate: () => Promise<void>;
  readonly onForget: () => Promise<void>;
}) {
  const pending = props.pendingPath === props.entry.path;
  const anotherPending =
    props.pendingPath !== null && props.pendingPath !== props.entry.path;
  const primaryAction = recentPrimaryAction(pending, props.failed);
  return (
    <div
      className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-foreground/3"
      aria-busy={pending}
      data-testid="recent-workspace-row"
    >
      <Folder
        className="size-3.5 shrink-0 text-muted-foreground/70"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <span className="block truncate text-ui-sm font-medium text-foreground/90">
          {workspaceFolderName(props.entry.path)}
        </span>
        <TooltipWrapper
          label={props.entry.path}
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <span className="block truncate text-ui-xs text-muted-foreground">
            {props.entry.path}
          </span>
        </TooltipWrapper>
        {props.failed ? (
          <span className="text-ui-xs text-destructive" role="status">
            Unavailable
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          type="button"
          size="xs"
          variant="ghost"
          data-recent-primary-action
          disabled={pending || anotherPending}
          aria-label={
            props.failed
              ? `Retry ${workspaceFolderName(props.entry.path)}`
              : `Add ${workspaceFolderName(props.entry.path)} to context`
          }
          onClick={() => void props.onAdd()}
        >
          {primaryAction}
        </Button>
        {props.failed ? (
          <TooltipWrapper
            label="Locate folder"
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={`Locate ${workspaceFolderName(props.entry.path)}`}
              onClick={() => void props.onLocate()}
            >
              <Search className="size-3.5" />
            </Button>
          </TooltipWrapper>
        ) : null}
        <ForgetButton entry={props.entry} onForget={props.onForget} />
      </div>
    </div>
  );
}

function recentPrimaryAction(pending: boolean, failed: boolean): ReactNode {
  if (pending) {
    return (
      <AgentSpinningDots
        className="text-current"
        testId={undefined}
        variant="dots"
      />
    );
  }
  if (failed) return "Retry";
  return "Add";
}

function ForgetButton(props: {
  readonly entry: WorkspaceRecentEntry;
  readonly onForget: () => Promise<void>;
}) {
  const name = workspaceFolderName(props.entry.path);
  return (
    <TooltipWrapper
      label="Forget folder"
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={`Forget ${name}`}
        className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        onClick={() => void props.onForget()}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </TooltipWrapper>
  );
}
