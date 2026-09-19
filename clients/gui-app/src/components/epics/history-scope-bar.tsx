import { useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { ClearFiltersButton } from "@/components/home/toolbar/clear-filters-button";
import {
  HistoryMessageHits,
  type HistoryMessageHitsInputs,
} from "@/components/epics/history-message-hits";
import {
  HistoryTaskControls,
  type HistoryTaskControlsProps,
} from "@/components/epics/history-task-controls";
import { HistoryGroupHeader } from "@/components/epics/history-group-header";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import type { HistoryScope } from "@/lib/history-scope";

/** A primitive: unchanged projections bail out of React state by value. */
export type HistoryCount = string | null;

const SCOPES: readonly HistoryScope[] = ["all", "tasks", "messages"];
const LABELS: Record<HistoryScope, string> = {
  all: "All",
  tasks: "Tasks",
  messages: "Messages",
};

/**
 * The message controller reports only here, below EpicsListPanelBody. Its
 * arrivals cannot re-render that parent; taskList is a React node supplied by
 * the parent, so its identity also survives these badge-only renders.
 * The task projection is a primitive prop, never mirrored into panel state.
 */
export function HistoryScopedResults(props: {
  readonly hostId: string | null;
  readonly scope: HistoryScope;
  readonly onScopeChange: (scope: HistoryScope) => void;
  readonly taskCount: HistoryCount;
  readonly taskList: ReactNode;
  readonly searchInput: ReactNode;
  readonly controls: HistoryTaskControlsProps;
  readonly messageHits: HistoryMessageHitsInputs;
  readonly rowsScopeRef: RefObject<HTMLDivElement | null>;
}): ReactNode {
  const { rowsScopeRef, scope, onScopeChange } = props;
  const [messageCount, setMessageCount] = useState<HistoryCount>(null);
  const hostEntry = useHostDirectoryEntry(props.hostId);
  const hostLabel = hostEntry?.label ?? "this machine";
  const counts = { all: null, tasks: props.taskCount, messages: messageCount };
  const hasQuery = props.messageHits.query.trim().length > 0;
  return (
    <Tabs
      value={scope}
      onValueChange={(next) => {
        if (next === "all" || next === "tasks" || next === "messages")
          onScopeChange(next);
      }}
      className="min-h-0 flex-1 gap-0"
    >
      <div className="@container/history-search px-2 pb-2">
        <div
          data-history-search-row=""
          className="flex flex-col items-start gap-2 @min-[32rem]/history-search:flex-row @min-[32rem]/history-search:items-center"
        >
          {props.searchInput}
          <TabsList
            variant="scope"
            size="scope"
            indicatorIndex={SCOPES.indexOf(scope)}
            aria-label="Search scope"
          >
            {SCOPES.map((value) => (
              <TabsTrigger key={value} variant="scope" value={value}>
                {LABELS[value]}
                <CountBadge count={hasQuery ? counts[value] : null} />
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      </div>
      <TabsContent value={scope} asChild>
        <div
          ref={rowsScopeRef}
          data-history-scroll=""
          className="min-h-0 flex-1 overflow-y-auto [--history-header-clearance:max(var(--history-tasks-header-height,3rem),var(--history-messages-header-height,3rem))] [&_[data-history-row-target]]:scroll-my-(--history-header-clearance) [&_[data-chat-search-nav]]:scroll-my-(--history-header-clearance)"
        >
          <p role="status" className="sr-only">
            {scope !== "messages"
              ? countStatus(props.taskCount, "tasks")
              : null}
            {scope === "all" &&
            props.taskCount !== null &&
            messageCount !== null
              ? " · "
              : null}
            {scope !== "tasks"
              ? countStatus(
                  messageCount,
                  `chats with message matches on ${hostLabel}`,
                )
              : null}
          </p>
          {scope === "messages" ? null : (
            <TasksGroup controls={props.controls} taskList={props.taskList} />
          )}
          <HistoryMessageHits
            {...props.messageHits}
            display={scope === "tasks" ? "count-only" : "list"}
            standalone={scope === "messages"}
            onCountChange={setMessageCount}
            onShowTasks={() => onScopeChange("tasks")}
          />
          <div className="h-10" aria-hidden="true" />
        </div>
      </TabsContent>
    </Tabs>
  );
}

function CountBadge(props: { readonly count: HistoryCount }): ReactNode {
  if (props.count === null) return null;
  return (
    <span className="inline-flex items-center rounded bg-foreground/12 px-1 py-0.5 text-micro font-medium leading-none text-foreground tabular-nums">
      {props.count === "pending" ? (
        <>
          <span className="sr-only">Searching</span>
          <AgentSpinningDots
            variant="typing"
            className={undefined}
            testId={undefined}
          />
        </>
      ) : (
        props.count
      )}
    </span>
  );
}

function countStatus(count: HistoryCount, unit: string): string | null {
  if (count === null) return null;
  if (count === "pending") return `Searching ${unit}…`;
  const label =
    count === "1"
      ? unit.replace(/^(tasks|chats)\b/, (word) => word.slice(0, -1))
      : unit;
  return `${count} ${label}`;
}

function TasksGroup(props: {
  readonly controls: HistoryTaskControlsProps;
  readonly taskList: ReactNode;
}): ReactNode {
  const headingId = useId();
  const groupRef = useRef<HTMLElement>(null);
  return (
    <section
      ref={groupRef}
      aria-labelledby={headingId}
      className="isolate pb-6"
    >
      <HistoryGroupHeader
        kind="tasks"
        id={headingId}
        hostLabel={null}
        targetRef={groupRef}
        pinBottom={false}
        actions={<HistoryTaskControls {...props.controls} />}
      />
      {/* Row content has its own z-10 controls. Contain those beneath this
          group's sticky header, as well as beneath the Messages header. */}
      <div className="isolate">
        {props.controls.filters.active ? (
          <div className="px-3.5 pb-2">
            <ClearFiltersButton onClick={props.controls.filters.onClear} />
          </div>
        ) : null}
        {props.taskList}
      </div>
    </section>
  );
}
