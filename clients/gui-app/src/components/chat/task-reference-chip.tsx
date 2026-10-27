import { ListTodo } from "lucide-react";
import {
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  QueryClientContext,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useEpicGetTaskContexts } from "@/hooks/epic/use-epic-get-task-contexts-query";
import {
  findCachedTaskContext,
  readEpicTitlesFromCloudTaskCaches,
  subscribeToCloudTaskListCaches,
  subscribeToTaskContextsCaches,
  type CloudEpicTasksCacheScope,
} from "@/lib/cloud-epic-tasks-query/cache";
import { openEpicFromList } from "@/lib/commands/actions/open-epic-from-list";
import { useRegisteredEpicTitles } from "@/lib/epic-selectors";
import { useOptionalHostClient } from "@/lib/host";
import { cn } from "@/lib/utils";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

const COMPLETE_TASK_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NO_TASK_IDS: readonly string[] = [];

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
  return <ResolvedTaskReferenceChip taskId={props.taskId} />;
}

function ResolvedTaskReferenceChip(props: {
  readonly taskId: string;
}): ReactNode {
  const title = useTaskReferenceTitle(props.taskId);
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
  const openTask = useCallback(() => {
    openEpicFromList(navigate, taskId, router.state.location.pathname, {
      title,
      source: "message_task_chip",
    });
  }, [navigate, router, taskId, title]);
  return (
    <button
      type="button"
      onClick={openTask}
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
 * The task's title from what the window already holds - a mounted task's live
 * title, then the task lists and title lookups already cached - else from one
 * lookup by id, which stays cached like every other title lookup. `null` while
 * nothing has answered, and for a task the person cannot open.
 */
function useTaskReferenceTitle(taskId: string): string | null {
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
  const known = nonEmptyTitle(liveTitle) ?? listTitle;
  // The own lookup stays mounted once asked, so its answer is not dropped and
  // asked for again while the chip is on screen.
  useEpicGetTaskContexts(known === null ? taskIds : NO_TASK_IDS, userId, {
    enabled: cloudAuthorized,
  });
  return known ?? lookupTitle;
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
