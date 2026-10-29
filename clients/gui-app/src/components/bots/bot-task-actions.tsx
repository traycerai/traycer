import type { ReactNode } from "react";
import type { BotTaskEntry } from "@traycer/protocol/host/bot/schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  useBotTaskRunNowMutation,
  useBotTaskSetPausedMutation,
  useBotTaskStopMutation,
} from "@/hooks/bots/use-bot-task-action-mutations";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { isRunningAutomation } from "@/lib/bots/bot-activity-model";
import { formatAbsoluteDateTime } from "@/lib/relative-time";

/**
 * An automation's controls on the bot's Activity page (Tracy Bots T92): who
 * paused it and since when, a Run now still to run, and Run now, Pause or
 * Resume, and Stop. The buttons show only while the tab's host runs the bot
 * and offers the method; what members did shows from any host.
 */
export function BotTaskControls(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly task: BotTaskEntry;
  /** Whether the tab's host is the one running the bot. */
  readonly boundHere: boolean;
  /** A member's name, as the environment's directory knows it. */
  readonly nameOf: (userId: string) => string;
}): ReactNode {
  const { botId, hostId, task, boundHere, nameOf } = props;
  const { pause, runRequest } = task;
  const running = isRunningAutomation(task);
  return (
    <>
      {pause === null ? null : (
        <span
          data-testid="bot-task-paused"
          className="text-ui-xs text-warning-foreground"
        >
          Paused by {nameOf(pause.byUserId)} since{" "}
          {formatAbsoluteDateTime(pause.since)}
        </span>
      )}
      {runRequest === null ? null : (
        <span
          data-testid="bot-task-run-request"
          data-state={runRequest.state}
          className="text-ui-xs text-muted-foreground"
        >
          {runRequest.state === "running"
            ? "Runs now"
            : "Requested; runs when the task next reports"}
          {pause === null ? null : ", then stays paused"}
        </span>
      )}
      {running && boundHere ? (
        <TaskActionButtons
          botId={botId}
          hostId={hostId}
          taskId={task.taskId}
          paused={pause !== null}
          runWaiting={runRequest !== null}
        />
      ) : null}
    </>
  );
}

function TaskActionButtons(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly taskId: string;
  readonly paused: boolean;
  readonly runWaiting: boolean;
}): ReactNode {
  const { botId, hostId, taskId, paused, runWaiting } = props;
  const client = useTabHostClient();
  const canRun = useHostMethodSupport(hostId, "bot.task.runNow") === true;
  const canPause = useHostMethodSupport(hostId, "bot.task.setPaused") === true;
  const canStop = useHostMethodSupport(hostId, "bot.task.stop") === true;
  const runNow = useBotTaskRunNowMutation(client);
  const setPaused = useBotTaskSetPausedMutation(client);
  const stop = useBotTaskStopMutation(client);
  if (!canRun && !canPause && !canStop) return null;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {canRun ? (
        <ActionButton
          testId="bot-task-run-now"
          label="Run now"
          pending={runNow.isPending}
          disabled={runWaiting}
          onClick={() => runNow.mutate({ botId, taskId })}
        />
      ) : null}
      {canPause ? (
        <ActionButton
          testId="bot-task-pause"
          label={paused ? "Resume" : "Pause"}
          pending={setPaused.isPending}
          disabled={false}
          onClick={() => setPaused.mutate({ botId, taskId, paused: !paused })}
        />
      ) : null}
      {canStop ? (
        <ActionButton
          testId="bot-task-stop"
          label="Stop"
          pending={stop.isPending}
          disabled={false}
          onClick={() => stop.mutate({ botId, taskId })}
        />
      ) : null}
    </span>
  );
}

function ActionButton(props: {
  readonly testId: string;
  readonly label: string;
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
}): ReactNode {
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      data-testid={props.testId}
      disabled={props.pending || props.disabled}
      onClick={props.onClick}
    >
      {props.label}
      {props.pending ? (
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      ) : null}
    </Button>
  );
}
