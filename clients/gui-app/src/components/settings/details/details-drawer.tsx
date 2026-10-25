import type { ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DetailsHostRows } from "@/components/settings/details/details-host-rows";
import { detailsTime } from "@/components/settings/details/details-copy";
import type {
  DetailsEntry,
  DetailsHistory,
  DetailsStatus,
  DetailsRecovery,
  DetailsSubject,
} from "@/lib/settings-details-entry";

function CurrentStatus(props: {
  readonly status: DetailsStatus;
  readonly onRecover: (recovery: DetailsRecovery) => void;
  readonly pending: boolean;
  readonly onSubjectSelect: (subject: DetailsSubject, title: string) => void;
}): ReactNode {
  const { status } = props;
  return (
    <div className="flex flex-col gap-2 py-2">
      <h3 className="font-medium">Now</h3>
      <p>{status.summary}</p>
      {status.currentVersion === null ? null : (
        <p>Version {status.currentVersion}</p>
      )}
      {status.changedAt === null && status.changedBy === null ? null : (
        <p className="text-ui-xs text-muted-foreground">
          {status.changedBy ?? "Unknown"} · {detailsTime(status.changedAt)}
        </p>
      )}
      {status.reason === null ? null : (
        <p className="text-ui-xs text-muted-foreground">{status.reason}</p>
      )}
      <DetailsHostRows
        hosts={status.hosts}
        onRecover={props.onRecover}
        pending={props.pending}
      />
      <ul className="divide-y divide-border/60">
        {(status.items ?? []).map((item) => (
          <li
            key={`${item.subject.kind}:${item.subject.key}`}
            className="flex flex-wrap items-center justify-between gap-2 py-3"
          >
            <div className="min-w-0">
              <p className="break-words font-medium">{item.title}</p>
              <p className="text-ui-xs text-muted-foreground">
                {item.summary} · {detailsTime(item.at)}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => props.onSubjectSelect(item.subject, item.title)}
            >
              Details
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function History(props: {
  readonly history: DetailsHistory;
  readonly onRecover: (recovery: DetailsRecovery) => void;
  readonly pending: boolean;
}): ReactNode {
  const { history } = props;
  return (
    <>
      {history.readerScope === "own" ? (
        <p className="text-ui-xs text-muted-foreground">
          Your changes and their current status.
        </p>
      ) : null}
      {history.entries.length === 0 ? (
        <p className="py-3 text-muted-foreground">
          No history kept for this yet.
        </p>
      ) : (
        <ol className="divide-y divide-border/60">
          {history.entries.map((entry) => (
            <li
              key={`${entry.at}:${entry.operation}:${entry.outcome}`}
              className="py-3"
            >
              <p>
                {entry.operation} · {entry.outcome}
              </p>
              <p className="text-ui-xs text-muted-foreground">
                {entry.actor?.label ?? "Traycer"} · {detailsTime(entry.at)}
              </p>
              <DetailsHostRows
                hosts={entry.hosts}
                onRecover={props.onRecover}
                pending={props.pending}
              />
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

/** A single drawer for every provider. Opening it starts no host lifecycle. */
export function DetailsDrawer(props: {
  readonly entry: DetailsEntry | null;
  readonly title: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly loading: boolean;
  readonly error: string | null;
  readonly exportPending: boolean;
  readonly recoveryPending: boolean;
  readonly onExport: () => void;
  readonly onRetry: () => void;
  readonly onRecover: (recovery: DetailsRecovery) => void;
  readonly onSubjectSelect: (subject: DetailsSubject, title: string) => void;
  readonly onBack: (() => void) | null;
  /**
   * The subject's own actions, under its status; `null` for none. They never
   * wait on the status: until it is read, or when it cannot be, they stand
   * alone.
   */
  readonly controls: ReactNode;
}): ReactNode {
  const status = props.entry?.status();
  const history = props.entry?.history();
  const hasHistory =
    history !== undefined && history.readerScope !== "status_only";
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{props.entry?.title ?? props.title}</SheetTitle>
          <SheetDescription>
            Reading details never wakes a host or spends credits.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-safe-bottom">
          {props.onBack === null ? null : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={props.onBack}
            >
              Back
            </Button>
          )}
          {props.loading ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
              tone="muted"
            />
          ) : null}
          {props.error === null ? null : (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-x-2 gap-y-1"
            >
              <p className="text-warning-foreground">{props.error}</p>
              <Button
                type="button"
                size="inline"
                variant="link"
                onClick={props.onRetry}
              >
                Retry
              </Button>
            </div>
          )}
          {/* The controls keep one place, so they never remount (and lose
              what they hold) when the status arrives. */}
          {status === undefined && props.controls === null ? null : (
            <Tabs defaultValue="status">
              <TabsList variant="line" className="max-w-full flex-wrap">
                <TabsTrigger value="status">Status</TabsTrigger>
                {hasHistory ? (
                  <TabsTrigger value="history">History</TabsTrigger>
                ) : null}
                {status === undefined ? null : (
                  <TabsTrigger value="export">Export diagnostics</TabsTrigger>
                )}
              </TabsList>
              <TabsContent value="status">
                {status === undefined ? null : (
                  <CurrentStatus
                    status={status}
                    onRecover={props.onRecover}
                    pending={props.recoveryPending}
                    onSubjectSelect={props.onSubjectSelect}
                  />
                )}
                {props.controls}
              </TabsContent>
              {hasHistory ? (
                <TabsContent value="history">
                  <History
                    history={history}
                    onRecover={props.onRecover}
                    pending={props.recoveryPending}
                  />
                </TabsContent>
              ) : null}
              {status === undefined ? null : (
                <DetailsExportTab
                  pending={props.exportPending}
                  onExport={props.onExport}
                />
              )}
            </Tabs>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function DetailsExportTab(props: {
  readonly pending: boolean;
  readonly onExport: () => void;
}): ReactNode {
  return (
    <TabsContent value="export">
      <div className="flex flex-col items-start gap-3 py-3">
        <p className="text-muted-foreground">
          Save diagnostics without values. You choose whether to share the file
          with support.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={props.pending}
          onClick={props.onExport}
        >
          Save diagnostics
          {props.pending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
              tone="muted"
            />
          ) : null}
        </Button>
      </div>
    </TabsContent>
  );
}
