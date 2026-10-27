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
  type TaskContextResult,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useHostQuery } from "@/hooks/host/use-host-query";
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
 * What the window already holds comes first: a mounted task's live title, the
 * cached task lists, and any cached title lookup (the tab strip's, over the
 * open tabs). Only an id none of them names is looked up, once, under the
 * chip's own key, which lives for the session; a lookup the chip started is
 * kept even once something else names the task. That lookup's answer is the
 * chip's verdict: a task it finds gone or out of reach stays text whatever an
 * older answer elsewhere still says.
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
  const params = useMemo(() => ({ taskIds: [taskId] }), [taskId]);
  // Disabled, the query still reads its own cached answer, which is how a
  // lookup the chip started is kept once the window names the task.
  const ownLookup = useHostQuery<HostRpcRegistry, "epic.getTaskContexts">({
    client: hostClient,
    method: "epic.getTaskContexts",
    params,
    cacheKeyIdentity:
      userId === null ? undefined : [userId, TASK_REFERENCE_LOOKUP_TAG],
    preflight: cloudVerdictPreflight("epic.getTaskContexts"),
    options: {
      enabled: cloudAuthorized && userId !== null && windowTitle === null,
      staleTime: (query) =>
        verdictOf(query.state.data?.tasks[taskId]) === null ? 0 : Infinity,
      gcTime: Infinity,
    },
  });
  const verdict = verdictOf(ownLookup.data?.tasks[taskId]);
  if (verdict === null) return windowTitle;
  if (verdict.kind === "unavailable") return null;
  return nonEmptyTitle(liveTitle) ?? verdict.title;
}

type TaskVerdict =
  | { readonly kind: "found"; readonly title: string | null }
  | { readonly kind: "unavailable" };

/**
 * What one answer settles about the task: found, or gone or out of the
 * person's reach. `null` for an answer that settles nothing (no answer yet, a
 * failed read, an older host), which is read again on the next mount.
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
  if (answer.status === "confirmed-absent") return { kind: "unavailable" };
  return answer.reason === "denied" ||
    answer.reason === "not-found-or-not-permitted"
    ? { kind: "unavailable" }
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
