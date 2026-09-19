import { useId, useState, type ReactNode, type RefObject } from "react";
import { Info } from "lucide-react";
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
  readonly controls: HistoryTaskControlsProps;
  readonly messageHits: HistoryMessageHitsInputs;
  readonly rowsScopeRef: RefObject<HTMLDivElement | null>;
}): ReactNode {
  const { rowsScopeRef, scope, onScopeChange } = props;
  const [messageCount, setMessageCount] = useState<HistoryCount>(null);
  const noticeId = useId();
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
      <div className="flex flex-wrap items-center gap-2.5 px-2 pb-2.5">
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
        <p className="min-w-0 flex-1 basis-60 text-ui-xs leading-4.5 text-pretty text-muted-foreground">
          <ScopeNote scope={scope} hostLabel={hostLabel} />
        </p>
      </div>
      <TabsContent value={scope} asChild>
        <div
          ref={rowsScopeRef}
          className="min-h-0 flex-1 overflow-y-auto border-t border-border pb-10"
        >
          <p
            role="status"
            className="px-3.5 pt-2.5 pb-1 text-ui-xs text-muted-foreground"
          >
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
          {scope === "messages" ? (
            <TaskControlsNotice
              controls={props.controls}
              filtersActive={props.messageHits.filtersActive}
              noticeId={noticeId}
            />
          ) : (
            <TasksGroup
              controls={props.controls}
              taskCount={props.taskCount}
              taskList={props.taskList}
            />
          )}
          <HistoryMessageHits
            {...props.messageHits}
            filtersActive={scope === "all" && props.messageHits.filtersActive}
            display={scope === "tasks" ? "count-only" : "list"}
            standalone={scope === "messages"}
            onCountChange={setMessageCount}
            onShowTasks={() => onScopeChange("tasks")}
          />
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

function ScopeNote(props: {
  readonly scope: HistoryScope;
  readonly hostLabel: string;
}): ReactNode {
  if (props.scope === "tasks")
    return "Titles, repos, branches and PR numbers, from your account’s task list.";
  if (props.scope === "messages")
    return (
      <>
        Message text on{" "}
        <b className="font-medium text-foreground">{props.hostLabel}</b>. Other
        machines aren’t searched.
      </>
    );
  return (
    <>
      Task titles, repos, branches and PR numbers from your account — and
      message text on{" "}
      <b className="font-medium text-foreground">{props.hostLabel}</b>.
    </>
  );
}

function TaskControlsNotice(props: {
  readonly controls: HistoryTaskControlsProps;
  readonly filtersActive: boolean;
  readonly noticeId: string;
}): ReactNode {
  return (
    <div className="mx-3.5 mb-2.5 flex items-start gap-2 rounded-sm border border-info/30 bg-info/10 px-2.5 py-2 text-ui-xs leading-4.5 text-info-foreground">
      <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p id={props.noticeId}>
          <strong className="font-semibold">
            Filters and sort apply to tasks only.
          </strong>{" "}
          This machine’s chat index doesn’t know about repos, workspaces or
          owners.
        </p>
        {props.filtersActive ? (
          <p>Your task filters are kept and come back in Tasks.</p>
        ) : null}
        <HistoryTaskControls
          {...props.controls}
          disabledReasonId={props.noticeId}
        />
      </div>
    </div>
  );
}

function TasksGroup(props: {
  readonly controls: HistoryTaskControlsProps;
  readonly taskCount: HistoryCount;
  readonly taskList: ReactNode;
}): ReactNode {
  return (
    <section aria-label="Tasks" className="pt-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 pb-1">
        <h2 className="flex items-baseline gap-2 text-overline font-semibold tracking-wide text-muted-foreground uppercase">
          Tasks{" "}
          <span className="text-micro font-normal tracking-normal tabular-nums">
            <CountBadge count={props.taskCount} />
          </span>
        </h2>
        <HistoryTaskControls {...props.controls} />
      </div>
      {props.controls.filters.active ? (
        <div className="px-3.5 pb-2">
          <ClearFiltersButton onClick={props.controls.filters.onClear} />
        </div>
      ) : null}
      {props.taskList}
    </section>
  );
}
