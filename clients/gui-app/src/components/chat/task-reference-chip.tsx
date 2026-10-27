import { ListTodo } from "lucide-react";
import {
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  QueryClientContext,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import {
  isFoundTaskContext,
  type GetTaskContextsResponse,
  type TaskContextResult,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useHostQueryWithResponseMap } from "@/hooks/host/use-host-query";
import {
  findCachedTaskContext,
  readEpicTitlesFromCloudTaskCaches,
  subscribeToCloudTaskListCaches,
  subscribeToTaskContextsCaches,
  type CloudEpicTasksCacheScope,
} from "@/lib/cloud-epic-tasks-query/cache";
import { openEpicFromList } from "@/lib/commands/actions/open-epic-from-list";
import { openEpicInBackground } from "@/lib/commands/actions/open-epic-in-background";
import { onMiddleClick } from "@/lib/dom/on-middle-click";
import { useRegisteredEpicTitles } from "@/lib/epic-selectors";
import { useOptionalHostClient, type HostRpcRegistry } from "@/lib/host";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { TASK_REFERENCE_LOOKUP_TAG } from "@/lib/query-keys/host-query-keys";
import { cn } from "@/lib/utils";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import {
  clearTaskLoss,
  currentTaskLossSequence,
  recordTaskLoss,
  taskLossFor,
  useTaskLossRegister,
  type TaskLoss,
} from "@/stores/epics/task-loss-register-store";

const COMPLETE_TASK_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An id-shaped token that named no agent: a chip with the task's title when it
 * is a complete task id the person can open, else the id as written. A code
 * span stays code, and a prefix is never a task. Until the title is known the
 * id is drawn as text, and markdown that renders with no host or query client
 * behind it (the layout editor's sample transcript) keeps the id.
 */
export function TaskReferenceChip(props: {
  readonly referenceId: string;
  readonly display: "text" | "code";
}): ReactNode {
  const { referenceId, display } = props;
  if (display === "code" || !COMPLETE_TASK_ID.test(referenceId)) {
    return referenceIdAsWritten(referenceId, display);
  }
  return <TaskTitleSourcesGate taskId={referenceId} />;
}

function TaskTitleSourcesGate(props: { readonly taskId: string }): ReactNode {
  const queryClient = useContext(QueryClientContext);
  const hostClient = useOptionalHostClient();
  if (queryClient === undefined || hostClient === null) {
    return referenceIdAsWritten(props.taskId, "text");
  }
  return (
    <ResolvedTaskReferenceChip taskId={props.taskId} hostClient={hostClient} />
  );
}

function ResolvedTaskReferenceChip(props: {
  readonly taskId: string;
  /** The app-wide host: a task is the account's, not one machine's. */
  readonly hostClient: HostClient<HostRpcRegistry>;
}): ReactNode {
  const title = useTaskReferenceTitle(props.taskId, props.hostClient);
  if (title === null) return referenceIdAsWritten(props.taskId, "text");
  return (
    <TooltipWrapper
      label={`${title}\n${props.taskId}`}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <TaskReferenceButton taskId={props.taskId} title={title} />
    </TooltipWrapper>
  );
}

function TaskReferenceButton(props: {
  readonly taskId: string;
  readonly title: string;
}): ReactNode {
  const { taskId, title } = props;
  const navigate = useNavigate();
  const router = useRouter();
  const openTask = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      // Cmd/Ctrl-click and the middle button open the task in a background
      // tab, as a task row in History or Home does.
      if (event.metaKey || event.ctrlKey || event.button === 1) {
        openEpicInBackground(taskId, title, "message_task_chip");
        return;
      }
      openEpicFromList(navigate, taskId, router.state.location.pathname, {
        title,
        source: "message_task_chip",
      });
    },
    [navigate, router, taskId, title],
  );
  return (
    <button
      type="button"
      onClick={openTask}
      onAuxClick={onMiddleClick(openTask)}
      className={cn(
        "mx-0.25 inline-flex max-w-[min(26rem,80vw)] items-center gap-1 rounded-md border border-primary/25 bg-primary/10 px-1.5 py-0.5 align-baseline",
        "text-ui-sm font-medium text-primary transition-colors hover:bg-primary/15 hover:text-primary focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
      )}
      data-task-reference={taskId}
      // Excluded from quote selection, as the agent chip is: a drag across it
      // must not append its title as quoted text.
      data-quote-exclude=""
    >
      <ListTodo className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{title}</span>
    </button>
  );
}

/**
 * The task's title, or `null` while nothing has answered and for a task the
 * person cannot open.
 *
 * What the window has learned about losing the task comes first: a deletion
 * or an answer that it is out of reach settles it as text, whatever title is
 * still held anywhere. Then what the window holds: a mounted task's live
 * title, the cached task lists, and any cached title lookup (the tab strip's,
 * over the open tabs). Only an id none of them names is looked up, under the
 * chip's own key, which lives for the session; the lookup stops once its
 * answer settles the task, and asks again when the person may have lost it.
 */
function useTaskReferenceTitle(
  taskId: string,
  hostClient: HostClient<HostRpcRegistry>,
): string | null {
  const taskIds = useMemo(() => [taskId], [taskId]);
  const [liveTitle] = useRegisteredEpicTitles(taskIds);
  const queryClient = useQueryClient();
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const cloudAuthorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const hostId = hostClient.getActiveHostId();
  const loss = useTaskLossRegister((state) =>
    taskLossFor(state, userId, hostId, taskId),
  );
  const scope = useMemo<CloudEpicTasksCacheScope | null>(
    () => (userId === null ? null : { hostId: null, userId }),
    [userId],
  );
  const subscribeToLists = useCallback(
    (onStoreChange: () => void) =>
      scope === null
        ? () => undefined
        : subscribeToCloudTaskListCaches(queryClient, scope, onStoreChange),
    [queryClient, scope],
  );
  const listTitle = useSyncExternalStore(subscribeToLists, () =>
    scope === null
      ? null
      : (readEpicTitlesFromCloudTaskCaches(queryClient, scope, taskIds)[
          taskId
        ] ?? null),
  );
  const subscribeToLookups = useCallback(
    (onStoreChange: () => void) =>
      scope === null
        ? () => undefined
        : subscribeToTaskContextsCaches(queryClient, scope, onStoreChange),
    [queryClient, scope],
  );
  const lookupTitle = useSyncExternalStore(subscribeToLookups, () =>
    scope === null ? null : cachedLookupTitle(queryClient, scope, taskId),
  );
  const windowTitle = nonEmptyTitle(liveTitle) ?? listTitle ?? lookupTitle;
  const settledLoss = loss !== null && loss.loss !== "recheck";
  const recheck = loss?.loss === "recheck";
  const params = useMemo(() => ({ taskIds: [taskId] }), [taskId]);
  // Disabled, the query still reads its own cached answer, which is how a
  // lookup the chip started is kept once the window names the task.
  const ownLookup = useHostQueryWithResponseMap<
    HostRpcRegistry,
    "epic.getTaskContexts",
    GetTaskContextsResponse,
    number
  >({
    client: hostClient,
    method: "epic.getTaskContexts",
    params,
    cacheKeyIdentity:
      userId === null ? undefined : [userId, TASK_REFERENCE_LOOKUP_TAG],
    preflight: cloudVerdictPreflight("epic.getTaskContexts"),
    captureRequestContext: currentTaskLossSequence,
    mapResponse: ({ response, requestContext }) =>
      userId === null || requestContext === undefined
        ? response
        : admitOwnAnswer(response, {
            userId,
            hostId,
            taskId,
            sentAt: requestContext,
          }),
    options: {
      // A settled answer is kept, not re-read on every reconnect: only one
      // that settles nothing, or a possible loss, asks again.
      enabled: (query) =>
        cloudAuthorized &&
        userId !== null &&
        !settledLoss &&
        (recheck ||
          (verdictOf(query.state.data?.tasks[taskId]) === null &&
            windowTitle === null)),
      staleTime: (query) =>
        verdictOf(query.state.data?.tasks[taskId]) === null ? 0 : Infinity,
      gcTime: Infinity,
    },
  });
  if (settledLoss) return null;
  const verdict = verdictOf(ownLookup.data?.tasks[taskId]);
  if (verdict === null) return windowTitle;
  if (verdict.kind !== "found") return null;
  return nonEmptyTitle(liveTitle) ?? verdict.title;
}

/**
 * The chip's own answer as it may be cached. Nothing makes a deleted task
 * reachable again, and an answer to a read sent before the window learned the
 * task was out of reach, or may have been lost, is not admitted for it, so
 * it settles nothing and is read again; a settling answer is recorded, and
 * one finding the task forgets what was learned before the read was sent.
 */
function admitOwnAnswer(
  response: GetTaskContextsResponse,
  read: {
    readonly userId: string;
    readonly hostId: string | null;
    readonly taskId: string;
    readonly sentAt: number;
  },
): GetTaskContextsResponse {
  const { userId, hostId, taskId, sentAt } = read;
  const loss = taskLossFor(
    useTaskLossRegister.getState(),
    userId,
    hostId,
    taskId,
  );
  if (
    loss !== null &&
    (loss.loss === "gone" || (loss.loss === "denied" && loss.sequence > sentAt))
  ) {
    return {
      ...response,
      tasks: { ...response.tasks, [taskId]: answerFor(loss.loss) },
    };
  }
  const verdict = verdictOf(response.tasks[taskId]);
  if (verdict === null) return response;
  if (loss?.loss === "recheck" && loss.sequence > sentAt) {
    return {
      ...response,
      tasks: Object.fromEntries(
        Object.entries(response.tasks).filter(([id]) => id !== taskId),
      ),
    };
  }
  if (verdict.kind === "found") {
    clearTaskLoss(userId, hostId, taskId, sentAt);
  } else {
    recordTaskLoss({ hostId, userId }, [taskId], verdict.kind);
  }
  return response;
}

function answerFor(loss: Exclude<TaskLoss, "recheck">): TaskContextResult {
  return loss === "gone"
    ? { status: "confirmed-absent" }
    : { status: "unknown", reason: "denied" };
}

type TaskVerdict =
  | { readonly kind: "found"; readonly title: string | null }
  | { readonly kind: "gone" }
  | { readonly kind: "denied" };

/**
 * What one answer settles about the task: found, gone, or out of the person's
 * reach. `null` for an answer that settles nothing (no answer yet, a failed
 * read, an older host), which is read again.
 */
function verdictOf(answer: TaskContextResult | undefined): TaskVerdict | null {
  if (answer === undefined) return null;
  if (isFoundTaskContext(answer)) {
    const light = answer.task.epic?.light;
    return {
      kind: "found",
      title:
        light === null || light === undefined
          ? null
          : nonEmptyTitle(light.title),
    };
  }
  if (answer.status === "confirmed-absent") return { kind: "gone" };
  return answer.reason === "denied" ||
    answer.reason === "not-found-or-not-permitted"
    ? { kind: "denied" }
    : null;
}

function cachedLookupTitle(
  queryClient: QueryClient,
  scope: CloudEpicTasksCacheScope,
  taskId: string,
): string | null {
  const light = findCachedTaskContext(queryClient, scope, taskId)?.task.epic
    ?.light;
  return light === null || light === undefined
    ? null
    : nonEmptyTitle(light.title);
}

function nonEmptyTitle(title: string | null): string | null {
  const trimmed = title?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function referenceIdAsWritten(
  referenceId: string,
  display: "text" | "code",
): ReactNode {
  if (display === "code") return <code>{referenceId}</code>;
  return <>{referenceId}</>;
}
