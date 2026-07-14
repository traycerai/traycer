import { useCallback, type ReactNode } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import type { TaskLight } from "@traycer/protocol/host/epic/unary-schemas";
import { Button } from "@/components/ui/button";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCloudEpicTasksQuery } from "@/hooks/epics/use-cloud-epic-tasks-query";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { epicDisplayTitle } from "@/lib/display-title";
import { useRefreshSpinner } from "@/hooks/use-refresh-spinner";
import { cn } from "@/lib/utils";
import type { OpenEpicInNewWindowDialogProps } from "./types";

const OPEN_EPIC_REFRESH_TIMEOUT_MS = 10_000;

export function OpenEpicInNewWindowDialog(
  props: OpenEpicInNewWindowDialogProps,
): ReactNode {
  const {
    hostId,
    tasks,
    query,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useCloudEpicTasksQuery(undefined, { enabled: true });
  const { data: queryData, isError, isFetching, isLoading, refetch } = query;
  const rows = buildOpenEpicRows(tasks);
  const refreshEpics = useCallback(async () => {
    await refetch();
  }, [refetch]);
  const refresh = useRefreshSpinner({
    onRefresh: refreshEpics,
    externalRefreshing: isFetching,
    timeoutMs: OPEN_EPIC_REFRESH_TIMEOUT_MS,
  });

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ExternalLink className="size-4" />
            Open Epic in New Window
          </DialogTitle>
          <DialogDescription className="sr-only">
            Select an Epic to move or focus in a Traycer window.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <div className="flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh epics"
              disabled={refresh.refreshing || hostId === null}
              onClick={refresh.trigger}
            >
              <RefreshCw
                className={cn("size-4", refresh.refreshing && "animate-spin")}
              />
            </Button>
          </div>
          <OpenEpicPickerBody
            state={openEpicPickerBodyState({
              rows,
              isLoading: isLoading || (isFetching && queryData === undefined),
              isError,
              isAvailable: props.flow.isAvailable,
              hasNextPage,
              isFetchingNextPage,
            })}
            onRetry={refresh.trigger}
            onSelect={(row) => {
              const tabId = useEpicCanvasStore
                .getState()
                .resolveTargetTabForEpic(row.epicId, row.title);
              props.flow.requestOpenInNewWindow({
                epicId: row.epicId,
                tabId,
                title: row.title,
              });
              props.close();
            }}
            onLoadMore={fetchNextPage}
          />
        </div>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}

interface OpenEpicPickerRow {
  readonly epicId: string;
  readonly title: string;
  // Raw user prompt; the render site derives the display-title fallback from it
  // via `epicDisplayTitle`.
  readonly initialUserPrompt: string;
  readonly updatedAt: number;
}

interface OpenEpicPickerBodyProps {
  readonly state: OpenEpicPickerBodyState;
  readonly onRetry: () => void;
  readonly onSelect: (row: OpenEpicPickerRow) => void;
  readonly onLoadMore: () => void;
}

type OpenEpicPickerBodyState =
  | { readonly kind: "unavailable" }
  | { readonly kind: "error" }
  | { readonly kind: "loading" }
  | { readonly kind: "empty" }
  | {
      readonly kind: "ready";
      readonly rows: readonly OpenEpicPickerRow[];
      readonly pagination: OpenEpicPickerPagination;
    };

interface OpenEpicPickerPagination {
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
}

function OpenEpicPickerBody(props: OpenEpicPickerBodyProps): ReactNode {
  if (props.state.kind === "unavailable") {
    return (
      <p className="text-ui-sm text-muted-foreground">
        Desktop window controls are unavailable.
      </p>
    );
  }
  if (props.state.kind === "error") {
    return (
      <div className="grid gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-ui-sm">
        <p className="font-medium text-destructive">Couldn't load Epics.</p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={props.onRetry}
          >
            Retry
          </Button>
          <ReportIssueAction
            context={createReportIssueContext({
              title: "Couldn't load Epics",
              message: null,
              code: null,
              source: "Open Epic in new window",
            })}
            presentation="text"
            className={undefined}
          />
        </div>
      </div>
    );
  }
  if (props.state.kind === "loading") {
    return (
      <div
        className="flex items-center gap-2 text-ui-sm text-muted-foreground"
        aria-busy="true"
      >
        <AgentSpinningDots
          testId={undefined}
          variant="orbit"
          className="text-muted-foreground"
        />
        Loading Epics…
      </div>
    );
  }
  if (props.state.kind === "empty") {
    return <p className="text-ui-sm text-muted-foreground">No Epics yet.</p>;
  }
  return (
    <div className="max-h-80 overflow-y-auto">
      <ul className="grid gap-1" data-testid="open-epic-new-window-rows">
        {props.state.rows.map((row) => (
          <li key={row.epicId}>
            <button
              type="button"
              data-testid={`open-epic-new-window-row-${row.epicId}`}
              onClick={() => props.onSelect(row)}
              className="grid w-full gap-1 rounded-md border border-border/70 bg-card p-3 text-left text-ui-sm transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="truncate font-medium text-foreground">
                {epicDisplayTitle({
                  title: row.title,
                  initialUserPrompt: row.initialUserPrompt,
                })}
              </span>
              <span className="text-ui-xs text-muted-foreground">
                {new Date(row.updatedAt).toLocaleString()}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {props.state.pagination.hasNextPage ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={props.state.pagination.isFetchingNextPage}
          onClick={props.onLoadMore}
          className="mt-2 w-full justify-center"
        >
          {props.state.pagination.isFetchingNextPage ? (
            <AgentSpinningDots
              variant="dots"
              className="text-muted-foreground"
              testId={undefined}
            />
          ) : null}
          Show more
        </Button>
      ) : null}
    </div>
  );
}

function openEpicPickerBodyState(input: {
  readonly rows: readonly OpenEpicPickerRow[];
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly isAvailable: boolean;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
}): OpenEpicPickerBodyState {
  if (!input.isAvailable) return { kind: "unavailable" };
  if (input.isError) return { kind: "error" };
  if (input.isLoading) return { kind: "loading" };
  if (input.rows.length === 0) return { kind: "empty" };
  return {
    kind: "ready",
    rows: input.rows,
    pagination: {
      hasNextPage: input.hasNextPage,
      isFetchingNextPage: input.isFetchingNextPage,
    },
  };
}

function buildOpenEpicRows(
  tasks: ReadonlyArray<TaskLight>,
): readonly OpenEpicPickerRow[] {
  return tasks.flatMap((task) => {
    const light = task.epic?.light;
    if (light === null || light === undefined) return [];
    return [
      {
        epicId: light.id,
        // Keep the RAW title. `row.title` feeds `resolveTargetTabForEpic` and
        // `requestOpenInNewWindow` (action/window data), so the "Untitled epic"
        // fallback must be applied only at the render site below.
        title: light.title,
        initialUserPrompt: light.initialUserPrompt,
        updatedAt: light.updatedAt,
      },
    ];
  });
}
