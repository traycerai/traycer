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
  organizationSubscribeV11,
  type OrganizationAction,
  type OrganizationCommand,
  type OrganizationView,
} from "@traycer/protocol/host/organization/contracts";
import { useHostClient } from "@/lib/host";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { useHostMutation, useHostQuery } from "@/hooks/host/use-host-query";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
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
  // Read here as well as in the subscription below: a rebuilt transport is
  // what gives a refused draft group intent its attempts back.
  const streamClient =
    useSurfaceHostStreamBinding(null)?.wsStreamClient ?? null;
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
  const hostSupport = useHostMethodSupport(hostId, "organization.command");
  // The projection is this account's or it is nobody's. Identity is the only
  // part of `supported` that governs whether the cached view may be SHOWN:
  // losing cloud authorization, or a handshake that has not landed, must not
  // empty a menu whose groups are still the signed-in account's, but a host
  // whose request context belongs to someone else must never be drawn.
  const ownAccount = userId !== null && userId === accountUserId;
  const supported = hostSupport === true && authorized && ownAccount;
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
  // How many times this provider has tried each tab's draft group intent,
  // and which of those sends has not come back.
  const draftIntentAttempts = useRef(new Map<string, number>());
  const draftIntentsInFlight = useRef(new Set<string>());
  // Opening is a local tab transition, independent of the selected host's
  // organization projection. Switching that host must not reopen closed siblings.
  const openedTasks = useRef(new Set<string>());
  useEffect(() => {
    lifecycle.current = createLifecycle();
  }, [scope]);
  // The host's own recovery evidence, and the only thing that reports a
  // session reopening after a drop or a stall: the client is NOT rebuilt for
  // either, so its identity cannot stand in for this. It both gives a
  // refused draft intent its attempts back and WAKES the send, because the
  // consuming effect is keyed on the view and a recovery frame that carries
  // the same data is structurally shared into the same object - no change,
  // no re-run. The epoch is that missing edge.
  const [recoveries, setRecoveries] = useState(0);
  useEffect(() => {
    draftIntentAttempts.current = new Map();
  }, [scope]);
  useEffect(() => {
    if (streamClient === null) return;
    return streamClient.subscribeAvailabilityRecovered(() => {
      draftIntentAttempts.current = new Map();
      setRecoveries((seen) => seen + 1);
    });
  }, [streamClient]);
  const refresh = useCallback(async () => {
    const auth = useAuthStore.getState();
    if (
      !supported ||
      hostId === null ||
      client.getActiveHostId() !== hostId ||
      client.getRequestContextUserId() !== userId ||
      auth.contextMetadata?.userId !== userId ||
      !authorizesCloudCapability(auth.status)
    )
      return;
    await queryClient.refetchQueries({
      queryKey: hostQueryKeys.methodScope(hostId, "organization.refresh"),
      predicate: (entry) => entry.queryKey.at(-1) === userId,
      type: "active",
    });
  }, [supported, hostId, client, userId, queryClient]);
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
          entry.queryKey.includes(userId),
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
    const newlyOpened = openIds.filter((id) => !openedTasks.current.has(id));
    const openTaskIds = new Set(openIds);
    openedTasks.current = openTaskIds;
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
    consumeDraftGroupIntents(query.data, command, {
      attempts: draftIntentAttempts.current,
      inFlight: draftIntentsInFlight.current,
    });
    projectOrganizationToTabs(query.data, userId);
  }, [supported, query.data, openIds, command, lifecycle, userId, recoveries]);
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
      hostSupport,
      client,
      userId,
      view: ownAccount ? query.data : undefined,
      register,
      command,
      refresh,
      openDialog,
    }),
    [
      supported,
      hostSupport,
      ownAccount,
      client,
      userId,
      query.data,
      register,
      command,
      refresh,
      openDialog,
    ],
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
  // Only this mount's own successful answer is accepted. A task set that was
  // subscribed before keeps its earlier answer in the query cache, and a
  // remount is handed that answer at once, ahead of the refetch: a group
  // dissolved since then would be projected onto the strip again until the
  // fresh view lands. A failed refetch also counts as fetched after mount
  // while `data` stays the cached answer, so success is required too.
  const refreshedAfterMount = refresh.isFetchedAfterMount && refresh.isSuccess;
  useEffect(() => {
    if (refresh.data && refreshedAfterMount && !receivedFrame.current)
      accept(refresh.data, taskIds);
  }, [refresh.data, refreshedAfterMount, accept, taskIds]);
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
        organizationSubscribeV11.serverFrameSchema.safeParse(envelope);
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
  if (previous.historyInvalidation !== next.historyInvalidation) return true;
  if (
    JSON.stringify([previous.groups, previous.catalog]) !==
    JSON.stringify([next.groups, next.catalog])
  )
    return true;
  // Loading metadata for a new page must not invalidate the page that loaded it.
  if (
    previous.appearances.some((appearance) => {
      const current = next.appearances.find(
        (row) => row.taskId === appearance.taskId,
      );
      return JSON.stringify(appearance) !== JSON.stringify(current);
    })
  )
    return true;
  return Object.entries(previous.taskLabels).some(
    ([id, labels]) =>
      Object.hasOwn(next.taskLabels, id) &&
      JSON.stringify(labels) !== JSON.stringify(next.taskLabels[id]),
  );
}

/**
 * How many times one tab's draft group intent is sent before this provider
 * leaves it alone.
 *
 * The retry rides the thing that already proves the transport is alive: a
 * view frame. Frames are host snapshots, so while the connection is down
 * none arrive and no attempt is spent; when it comes back the fresh snapshot
 * IS the recovery event and the next attempt goes out on it. That is why
 * there is no timer and no backoff here - there is nothing to wait for that
 * the frame does not already say.
 *
 * The count is what stops a host that is reachable and REFUSING from being
 * asked on every frame. It resets when the stream transport is rebuilt, or
 * when the host or account changes, so a long-lived window that used up its
 * attempts on one bad connection gets them back on the next. An intent that
 * runs out stays in the layout, and the next launch picks it up.
 */
const DRAFT_INTENT_MAX_ATTEMPTS = 3;

/**
 * Sends the group a draft tab was started in, once that draft has become a
 * task.
 *
 * The stored intent is the only record of the user's choice, so it is cleared
 * when the command is ACKNOWLEDGED, never when it is sent: clearing first lost
 * the choice outright whenever the send failed or the renderer reloaded while
 * it was in flight. It is also no longer withheld until the task has cloud
 * metadata - the host accepts the assignment for a task it can prove this
 * account created here, and holds delivery itself.
 */
function consumeDraftGroupIntents(
  view: OrganizationView,
  command: (action: OrganizationAction) => Promise<void>,
  tracking: {
    readonly attempts: Map<string, number>;
    readonly inFlight: Set<string>;
  },
): void {
  const { attempts, inFlight } = tracking;
  const tabs = useEpicCanvasStore.getState();
  for (const tabId of tabs.openTabOrder) {
    const task = tabs.tabsById[tabId];
    const customization =
      useTabsStore.getState().customizations?.[`epic:${tabId}`];
    const pendingGroupId = customization?.pendingGroupId;
    if (!task || !pendingGroupId) continue;
    // A send that has not come back is still this tab's send. Frames keep
    // arriving while it is in flight, and without this each one would start
    // another command for the same assignment.
    if (inFlight.has(tabId)) continue;
    const spent = attempts.get(tabId) ?? 0;
    if (spent >= DRAFT_INTENT_MAX_ATTEMPTS) continue;
    const clearIntent = (): void => {
      useTabsStore
        .getState()
        .setTabCustomization(
          { kind: "epic", id: tabId },
          { pendingGroupId: null },
        );
    };
    if (!view.groups.groups.some((group) => group.groupId === pendingGroupId)) {
      // The group the draft named is gone from the account. Nothing to send,
      // and nothing left for the intent to mean.
      clearIntent();
      continue;
    }
    attempts.set(tabId, spent + 1);
    inFlight.add(tabId);
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
    })
      .then(clearIntent)
      .catch(() => undefined)
      .finally(() => inFlight.delete(tabId));
  }
}

function createLifecycle(): OrganizationLifecycle {
  return {
    seenFailures: new Set(),
    confirmedView: null,
  };
}
function OrganizationOpenTask({ taskId }: { readonly taskId: string }) {
  const isLocal = useRegisteredEpicLocalHome(taskId);
  useOrganizationTasks(isLocal ? [] : [taskId]);
  return null;
}
