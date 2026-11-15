import { useState, type ReactNode } from "react";
import { EllipsisVertical } from "lucide-react";
import type { BotTaskEntry } from "@traycer/protocol/host/bot/schemas";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useBotTaskRunNowMutation,
  useBotTaskSetPausedMutation,
  useBotTaskStopMutation,
} from "@/hooks/bots/use-bot-task-action-mutations";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { formatAbsoluteDateTime } from "@/lib/relative-time";

/** Reporting controls stay bound to the host and methods that can perform them. */
export function BotTaskControls(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly task: BotTaskEntry;
  readonly boundHere: boolean;
  readonly nameOf: (userId: string) => string;
}): ReactNode {
  const { task, boundHere } = props;
  if (task.state === "ended" && task.endedReason === "by-bot") {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Reporting actions"
          >
            <EllipsisVertical aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-[min(16rem,calc(100vw-2rem))]"
        >
          <p className="px-2 py-1.5 text-ui-xs text-muted-foreground">
            Reporting has ended. The task and its agents can keep working.
          </p>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  if (task.state !== "tracking" || task.cadence.kind !== "every" || !boundHere)
    return null;
  return <TaskActionMenu {...props} />;
}

function TaskActionMenu(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly task: BotTaskEntry;
  readonly nameOf: (userId: string) => string;
}): ReactNode {
  const { botId, hostId, task, nameOf } = props;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const client = useTabHostClient();
  const canRun = useHostMethodSupport(hostId, "bot.task.runNow") === true;
  const canPause = useHostMethodSupport(hostId, "bot.task.setPaused") === true;
  const canStop = useHostMethodSupport(hostId, "bot.task.stop") === true;
  const runNow = useBotTaskRunNowMutation(client);
  const setPaused = useBotTaskSetPausedMutation(client);
  const stop = useBotTaskStopMutation(client);
  if (!canRun && !canPause && !canStop) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Reporting actions"
          >
            <EllipsisVertical aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-[min(16rem,calc(100vw-2rem))]"
        >
          <p className="px-2 py-1.5 text-ui-xs text-muted-foreground">
            These controls change reports only. The task and its agents can keep
            working.
          </p>
          {task.pause === null ? null : (
            <p className="px-2 py-1.5 text-ui-xs text-muted-foreground">
              Paused by {nameOf(task.pause.byUserId)} since{" "}
              {formatAbsoluteDateTime(task.pause.since)}
            </p>
          )}
          {task.runRequest === null ? null : (
            <p className="px-2 py-1.5 text-ui-xs text-muted-foreground">
              {task.runRequest.state === "running"
                ? "Runs now"
                : "Requested; runs when the task next reports"}
              {task.pause === null ? null : ", then stays paused"}
            </p>
          )}
          <DropdownMenuSeparator />
          {canRun ? (
            <DropdownMenuItem
              data-testid="bot-task-run-now"
              disabled={runNow.isPending || task.runRequest !== null}
              onSelect={() => runNow.mutate({ botId, taskId: task.taskId })}
            >
              Check in now
            </DropdownMenuItem>
          ) : null}
          {canPause ? (
            <DropdownMenuItem
              data-testid="bot-task-pause"
              disabled={setPaused.isPending}
              onSelect={() =>
                setPaused.mutate({
                  botId,
                  taskId: task.taskId,
                  paused: task.pause === null,
                })
              }
            >
              {task.pause === null ? "Pause reports" : "Resume reports"}
            </DropdownMenuItem>
          ) : null}
          {canStop ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                data-testid="bot-task-stop"
                onSelect={() => setConfirmOpen(true)}
              >
                End reporting…
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDestructiveDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="End reporting?"
        description="You can’t resume reports for this task. The task and its agents can keep working."
        cascadeSummary={null}
        actionLabel="End reporting"
        isPending={stop.isPending}
        blockedReason={null}
        onConfirm={() =>
          stop.mutate(
            { botId, taskId: task.taskId },
            { onSuccess: () => setConfirmOpen(false) },
          )
        }
      />
    </>
  );
}
