import { captureOrganizationDialogOpener } from "@/components/organization/organization-dialog-focus";
import { useRegisteredEpicLocalHome } from "@/lib/epic-selectors";
import {
  OrganizationContext,
  taskOrganization,
  useOrganizationTasks,
  organizationPreflight,
} from "./organization-context";
import {
  OrganizationDialogHost,
  type OrganizationDialog,
} from "@/components/organization/organization-dialogs";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { useShallow } from "zustand/react/shallow";
import { toast } from "sonner";
import {
  organizationSubscribeV10,
  type OrganizationAction,
  type OrganizationCommand,
  type OrganizationView,
} from "@traycer/protocol/host/organization/contracts";
import { useHostClient } from "@/lib/host";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { useHostMutation, useHostQuery } from "@/hooks/host/use-host-query";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useSurfaceHostStreamBinding } from "@/hooks/host/use-surface-host-stream-binding";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { organizationKeys } from "@/lib/query-keys/organization-query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";
import { useTabsStore } from "@/stores/tabs/store";
import { DEFAULT_TAB_CUSTOMIZATION } from "@/stores/tabs/tab-groups";

const EMPTY_TASK_IDS: string[] = [];

interface OrganizationLifecycle {
  openedTasks: Set<string>;
  readonly seenFailures: Set<string>;
  confirmedView: OrganizationView | null;
}

/** One host-owned projection. React only subscribes and sends commands; it never queues edits. */
export function OrganizationProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  const [dialog, setDialog] = useState<{
    scope: string;
    value: OrganizationDialog;
    returnFocusTo: HTMLElement | null;
  } | null>(null);
  const client = useHostClient();
  const readiness = useReactiveHostReadiness(client);
  const { hostId, requestContextUserId: userId } = readiness;
  const accountUserId = useAuthStore(
    (state) => state.contextMetadata?.userId ?? null,
  );
  const scope = `${hostId}:${userId}`;
  useLayoutEffect(() => {
    if (accountUserId === null) return;
    const state = useTabsStore.getState();
    const customizations = Object.fromEntries(
      Object.entries(state.customizations ?? {}).map(([id, appearance]) => [
        id,
        appearance.organizationOwnerId &&
        appearance.organizationOwnerId !== accountUserId
          ? { ...DEFAULT_TAB_CUSTOMIZATION }
          : appearance,
      ]),
    );
    useTabsStore.setState({ customizations });
    state.repair();
  }, [accountUserId]);
  const authorized = useAuthStore((s) => authorizesCloudCapability(s.status));
  const supportsCommand = useHostSupportsMethod(hostId, "organization.command");
  const supported =
    supportsCommand &&
    authorized &&
    userId !== null &&
    userId === accountUserId;
  const queryClient = useQueryClient();
  const key = useMemo(
    () => organizationKeys.view(hostId, userId),
    [hostId, userId],
  );
  const [requests, setRequests] = useState<
    ReadonlyMap<string, readonly string[]>
  >(new Map());
  const openIds = useEpicCanvasStore(
    useShallow((s) =>
      s.openTabOrder.flatMap((id) =>
        s.tabsById[id] ? [s.tabsById[id].epicId] : [],
      ),
    ),
  );
  const register = useCallback((id: string, ids: readonly string[]) => {
    setRequests((current) => new Map(current).set(id, ids));
    return () =>
      setRequests((current) => {
        const next = new Map(current);
        next.delete(id);
        return next;
      });
  }, []);
  const taskIds = useMemo(
    () => [...new Set([...requests.values()].flat())].sort(),
    [requests],
  );
  const chunks = useMemo(() => {
    const result: string[][] = [];
    for (let i = 0; i < taskIds.length; i += 100)
      result.push(taskIds.slice(i, i + 100));
    return [EMPTY_TASK_IDS, ...result];
  }, [taskIds]);
  const query = useHostQuery({
    client,
    method: "organization.read",
    params: { taskIds: [] },
    cacheKeyIdentity: [userId],
    options: { enabled: false, staleTime: Infinity },
  });
  const accept = useCallback(
    (next: OrganizationView, ids: readonly string[]) => {
      if (
        client.getRequestContextUserId() !== userId ||
        client.getActiveHostId() !== hostId
      )
        return;
      const requestedIds = new Set(ids);
      queryClient.setQueryData<OrganizationView>(key, (previous) => ({
        ...next,
        ready: previous?.ready || next.ready,
        appearances: [
          ...(previous?.appearances.filter(
            (a) => !requestedIds.has(a.taskId),
          ) ?? []),
          ...next.appearances,
        ],
        taskLabels: {
          ...Object.fromEntries(
            Object.entries(previous?.taskLabels ?? {}).filter(
              ([id]) => !requestedIds.has(id),
            ),
          ),
          ...next.taskLabels,
        },
      }));
    },
    [key, queryClient, client, userId, hostId],
  );
  const mutation = useHostMutation({
    client,
    method: "organization.command",
    mapVariables: (variables: {
      readonly command: OrganizationCommand;
      readonly userId: string | null;
      readonly hostId: string | null;
    }) => {
      organizationPreflight(client, variables.userId, "organization.command")();
      if (client.getActiveHostId() !== variables.hostId)
        throw new Error(
          "Organization device changed. Reopen this control to try again.",
        );
      return variables.command;
    },
    options: {
      mutationKey: organizationKeys.command(),
      onError: (error) =>
        toastFromHostError(error, "Couldn't save organization changes."),
    },
  });
  const { mutateAsync } = mutation;
  const command = useCallback(
    async (action: OrganizationAction) => {
      await mutateAsync({
        command: { commandId: crypto.randomUUID(), action },
        userId,
        hostId,
      });
      if (
        client.getRequestContextUserId() !== userId ||
        client.getActiveHostId() !== hostId
      )
        throw new Error("Organization account changed.");
    },
    [mutateAsync, client, userId, hostId],
  );
  const lifecycle = useRef<OrganizationLifecycle | null>(null);
  useEffect(() => {
    lifecycle.current = createLifecycle();
  }, [scope]);
  useEffect(() => {
    const current = lifecycle.current;
    if (current === null) return;
    const view = query.data;
    if (!supported || !view?.ready || view.pending.length > 0) return;
    const previous = current.confirmedView;
    if (previous !== null && organizationFiltersChanged(previous, view)) {
      void queryClient.invalidateQueries({
        queryKey: hostQueryKeys.methodScope(hostId, "organization.history"),
      });
      void queryClient.invalidateQueries({
        predicate: (entry) =>
          entry.queryKey.includes("cloud.listTasks") &&
          entry.queryKey.includes(userId) &&
          entry.queryKey.some(
            (part) =>
              typeof part === "object" &&
              part !== null &&
              "filters" in part &&
              typeof part.filters === "object" &&
              part.filters !== null &&
              ("labelNames" in part.filters ||
                "groupIds" in part.filters ||
                "includeUngrouped" in part.filters),
          ),
      });
    }
    current.confirmedView = view;
  }, [query.data, supported, queryClient, lifecycle, hostId, userId]);
  useEffect(() => {
    const current = lifecycle.current;
    if (!supported || current === null) return;
    const failures = (query.data?.failures ?? []).filter((failure) => {
      const id = `${userId}:${failure.commandIds.join(",")}`;
      if (current.seenFailures.has(id)) return false;
      current.seenFailures.add(id);
      return true;
    });
    const failure = failures.at(-1);
    if (failure)
      toast.warning(
        failure.reason === "conflict"
          ? "Organization changed elsewhere. Your pending edits were discarded."
          : "An organization edit couldn't be saved.",
        { description: failure.message },
      );
  }, [query.data?.failures, userId, lifecycle, supported]);
  useEffect(() => {
    const current = lifecycle.current;
    if (!supported || current === null || query.data === undefined) return;
    if (!query.data.ready) return;
    // Only opening a task opens its saved siblings. A remote edit never opens or closes local tabs.
    const newlyOpened = openIds.filter((id) => !current.openedTasks.has(id));
    const openTaskIds = new Set(openIds);
    current.openedTasks = openTaskIds;
    const taskGroups = new Map(
      query.data.groups.memberships.map((member) => [
        member.taskId,
        member.groupId,
      ]),
    );
    for (const taskId of newlyOpened) {
      const groupId = taskGroups.get(taskId);
      if (!groupId) continue;
      for (const member of query.data.groups.memberships
        .filter((m) => m.groupId === groupId)
        .sort((a, b) => a.position - b.position)) {
        if (!openTaskIds.has(member.taskId)) {
          openTaskIds.add(member.taskId);
          useEpicCanvasStore
            .getState()
            .openEpicTabInBackground(member.taskId, undefined);
        }
      }
    }
    consumeDraftGroupIntents(query.data, command);
    projectOrganizationToTabs(query.data, userId);
  }, [supported, query.data, openIds, command, lifecycle, userId]);
  const openDialog = useCallback(
    (value: OrganizationDialog) => {
      const opener = captureOrganizationDialogOpener();
      setDialog((current) => ({
        scope,
        value,
        returnFocusTo:
          current?.scope === scope ? current.returnFocusTo : opener,
      }));
    },
    [scope],
  );
  const value = useMemo(
    () => ({
      supported,
      client,
      userId,
      view: supported ? query.data : undefined,
      register,
      command,
      openDialog,
    }),
    [supported, client, userId, query.data, register, command, openDialog],
  );
  return (
    <OrganizationContext value={value}>
      {openIds.map((taskId) => (
        <OrganizationOpenTask key={taskId} taskId={taskId} />
      ))}
      {supported
        ? chunks.map((ids) => (
            <OrganizationSubscription
              key={ids.join(",")}
              taskIds={ids}
              userId={userId}
              accept={accept}
            />
          ))
        : null}
      {children}
      <OrganizationDialogHost
        dialog={supported && dialog?.scope === scope ? dialog.value : null}
        onClose={() => setDialog(null)}
        returnFocusTo={dialog?.returnFocusTo}
      />
    </OrganizationContext>
  );
}

function OrganizationSubscription(props: {
  readonly userId: string | null;
  readonly taskIds: string[];
  readonly accept: (view: OrganizationView, ids: readonly string[]) => void;
}) {
  const client = useHostClient();
  const binding = useSurfaceHostStreamBinding(null);
  const streamClient = binding?.wsStreamClient ?? null;
  const { taskIds, accept } = props;
  const receivedFrame = useRef(false);
  const refresh = useHostQuery({
    client,
    method: "organization.refresh",
    params: { taskIds },
    cacheKeyIdentity: [props.userId],
    preflight: organizationPreflight(
      client,
      props.userId,
      "organization.refresh",
    ),
    options: { staleTime: Infinity, refetchOnMount: "always" },
  });
  useEffect(() => {
    if (refresh.data && !receivedFrame.current) accept(refresh.data, taskIds);
  }, [refresh.data, accept, taskIds]);
  useEffect(() => {
    let active = true;
    if (streamClient === null)
      return () => {
        active = false;
      };
    receivedFrame.current = false;
    const session = streamClient.subscribe("organization.subscribe", {
      taskIds,
    });
    session.onServerFrame((envelope) => {
      const result =
        organizationSubscribeV10.serverFrameSchema.safeParse(envelope);
      if (active && result.success) {
        receivedFrame.current = true;
        accept(result.data.view, taskIds);
      }
    });
    return () => {
      active = false;
      session.close();
    };
  }, [client, streamClient, taskIds, accept]);
  return null;
}

function projectOrganizationToTabs(
  view: OrganizationView,
  userId: string | null,
): void {
  const tabs = useEpicCanvasStore.getState();
  const state = useTabsStore.getState();
  const groups = { ...state.groups };
  const customizations = { ...state.customizations };
  for (const group of view.groups.groups)
    groups[group.groupId] = {
      name: group.name,
      color: group.color,
      organizationOwnerId: userId,
      collapsed: state.groups?.[group.groupId]?.collapsed ?? false,
    };
  for (const tabId of tabs.openTabOrder) {
    const tab = tabs.tabsById[tabId];
    if (tab === undefined) continue;
    const org = taskOrganization(view, tab.epicId, undefined);
    const key = `epic:${tabId}`;
    if (org === undefined) {
      const current = state.customizations?.[key];
      // Groups are account-wide, even before this task's appearance loads.
      if (current?.groupId && current.organizationOwnerId === userId)
        customizations[key] = { ...current, groupId: null };
      continue;
    }
    customizations[key] = {
      ...(customizations[key] ?? DEFAULT_TAB_CUSTOMIZATION),
      organizationOwnerId: userId,
      groupId: org.group?.groupId ?? null,
      color: org.appearance.color,
      icon: org.appearance.icon,
    };
  }
  useTabsStore.setState({ groups, customizations });
  state.repair();
}

function organizationFiltersChanged(
  previous: OrganizationView,
  next: OrganizationView,
): boolean {
  if (
    JSON.stringify([previous.groups, previous.catalog]) !==
    JSON.stringify([next.groups, next.catalog])
  )
    return true;
  // Loading metadata for a new page must not invalidate the page that loaded it.
  return Object.entries(previous.taskLabels).some(
    ([id, labels]) =>
      Object.hasOwn(next.taskLabels, id) &&
      JSON.stringify(labels) !== JSON.stringify(next.taskLabels[id]),
  );
}

function consumeDraftGroupIntents(
  view: OrganizationView,
  command: (action: OrganizationAction) => Promise<void>,
): void {
  const tabs = useEpicCanvasStore.getState();
  for (const tabId of tabs.openTabOrder) {
    const task = tabs.tabsById[tabId];
    const customization =
      useTabsStore.getState().customizations?.[`epic:${tabId}`];
    const pendingGroupId = customization?.pendingGroupId;
    if (
      !task ||
      !pendingGroupId ||
      !view.appearances.some((a) => a.taskId === task.epicId)
    )
      continue;
    useTabsStore
      .getState()
      .setTabCustomization(
        { kind: "epic", id: tabId },
        { pendingGroupId: null },
      );
    if (!view.groups.groups.some((group) => group.groupId === pendingGroupId))
      continue;
    void command({
      kind: "groups",
      operations: [
        {
          operation: "moveTask",
          taskId: task.epicId,
          groupId: pendingGroupId,
          position: view.groups.memberships.filter(
            (m) => m.groupId === pendingGroupId,
          ).length,
        },
      ],
    }).catch(() => undefined);
  }
}

function createLifecycle(): OrganizationLifecycle {
  return {
    openedTasks: new Set(),
    seenFailures: new Set(),
    confirmedView: null,
  };
}
function OrganizationOpenTask({ taskId }: { readonly taskId: string }) {
  const isLocal = useRegisteredEpicLocalHome(taskId);
  useOrganizationTasks(isLocal ? [] : [taskId]);
  return null;
}
