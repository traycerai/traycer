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
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { useShallow } from "zustand/react/shallow";
import { toast } from "sonner";
import {
  organizationSubscribeV11,
  type OrganizationAction,
  type OrganizationCommand,
  type OrganizationView,
} from "@traycer/protocol/host/organization/contracts";
import { useAuthService, useHostClient } from "@/lib/host";
import { authMutationKeys } from "@/lib/query-keys/auth-mutation-keys";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { useHostMutation, useHostQuery } from "@/hooks/host/use-host-query";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useSurfaceHostStreamBinding } from "@/hooks/host/use-surface-host-stream-binding";
import {
  usePoolTierHostClient,
  usePoolTierStreamClient,
} from "@/hooks/host/use-pool-tier";
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

interface OrganizationIdentityScope {
  readonly hostId: string | null;
  readonly userId: string | null;
  // `null` means no account-wide view has arrived; older hosts omit the token.
  historyInvalidation: string | undefined | null;
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
  // Organization is account-wide: the pool's family (see `usePoolTierHostClient`).
  const client = usePoolTierHostClient(useHostClient());
  const binding = useSurfaceHostStreamBinding(null);
  const readiness = useReactiveHostReadiness(client);
  const { hostId, requestContextUserId: userId } = readiness;
  // The SAME stream the subscription below rides, not the surface's own. In a
  // pool build those are different hosts: commands and frames would go to the
  // pool while a refused draft intent waited on a recovery from somewhere
  // else, and the recovery that actually concerns it would never arrive.
  const streamClient = usePoolTierStreamClient(
    binding?.wsStreamClient ?? null,
    userId,
  );
  const accountUserId = useAuthStore(
    (state) => state.contextMetadata?.userId ?? null,
  );
  const auth = useAuthService();
  const identityScope = useRef<OrganizationIdentityScope | null>(null);
  useLayoutEffect(() => {
    identityScope.current = {
      hostId,
      userId: accountUserId === userId ? userId : null,
      historyInvalidation: null,
    };
    return () => {
      identityScope.current = null;
    };
  }, [hostId, userId, accountUserId]);
  const { mutate: revalidateIdentity } = useMutation({
    mutationKey: authMutationKeys.revalidateContextAfterInvalidation(userId),
    mutationFn: (expected: OrganizationIdentityScope) => {
      const account = useAuthStore.getState();
      if (
        identityScope.current !== expected ||
        expected.userId === null ||
        client.getActiveHostId() !== expected.hostId ||
        client.getRequestContextUserId() !== expected.userId ||
        account.contextMetadata?.userId !== expected.userId ||
        !authorizesCloudCapability(account.status)
      )
        return Promise.resolve(null);
      return auth.revalidateCurrentContextAfterInvalidation();
    },
    retry: false,
  });
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
      // Task chunks can carry tokens from another subscription generation.
      // Keep only the account-wide baseline, including across reconnects.
      const current = identityScope.current;
      if (
        ids.length === 0 &&
        current !== null &&
        current.userId !== null &&
        useAuthStore.getState().contextMetadata?.userId === userId
      ) {
        const previous = current.historyInvalidation;
        current.historyInvalidation = next.historyInvalidation;
        if (previous !== null && previous !== next.historyInvalidation)
          revalidateIdentity(current);
      }
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
    [key, queryClient, client, userId, hostId, revalidateIdentity],
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
      retireSupersededDraftIntents(action);
    },
    [mutateAsync, client, userId, hostId],
  );
  const lifecycle = useRef<OrganizationLifecycle | null>(null);
  // How many times this provider has tried each tab's draft group intent,
  // and which of those sends has not come back - owned by one scope, and
  // replaced wholesale when the host or account changes. A send closes over
  // the object it started under, so a reply from the old scope settles that
  // object and can neither free nor strand a tab the new one is tracking.
  const draftTracking = useRef<DraftIntentTracking>(newDraftTracking());
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
  // The same count, readable from inside a send's settlement callback, which
  // closes over the render it started in and cannot see the state.
  const recoveryCount = useRef(0);
  useEffect(() => {
    draftTracking.current = newDraftTracking();
  }, [scope]);
  useEffect(() => {
    if (streamClient === null) return;
    return streamClient.subscribeAvailabilityRecovered(() => {
      draftTracking.current.attempts.clear();
      recoveryCount.current += 1;
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
      tracking: draftTracking.current,
      recoveries: recoveryCount,
      wake: () => setRecoveries((seen) => seen + 1),
    });
    projectOrganizationToTabs(query.data, userId);
    // `command` changes with the host/account scope, so scope changes also
    // re-run this effect.
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
  const client = usePoolTierHostClient(useHostClient());
  const binding = useSurfaceHostStreamBinding(null);
  const streamClient = usePoolTierStreamClient(
    binding?.wsStreamClient ?? null,
    props.userId,
  );
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
 * Relevant view/open changes or a transport recovery wake the sender; no
 * timer retries a refusal. The count prevents repeated frames from spending
 * unbounded attempts on a reachable host that keeps refusing. Recovery or a
 * host/account scope change resets the count. An exhausted intent stays in
 * the layout for a later recovery or launch.
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
  context: {
    readonly tracking: DraftIntentTracking;
    readonly recoveries: { current: number };
    readonly wake: () => void;
  },
): void {
  const { attempts, inFlight } = context.tracking;
  const { recoveries, wake } = context;
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
    // A recovery that lands WHILE this is in flight is skipped by the guard
    // above, and the settlement below is the last thing that happens for
    // this tab - no frame, no further recovery. So the send remembers how
    // many recoveries it started after, and asks for one more pass if that
    // moved while it was out. Without it a stream that reconnects faster
    // than a unary request times out leaves the intent inert.
    const startedAfter = recoveries.current;
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
      .finally(() => {
        inFlight.delete(tabId);
        if (recoveries.current !== startedAfter) wake();
      });
  }
}

/**
 * Forgets a draft's group intent once the account has DURABLY accepted a
 * later choice for the same task.
 *
 * The intent deliberately survives a refusal - that is what it is for - so
 * the only thing allowed to retire it is a newer decision that actually
 * landed. A membership in the view is NOT that: the view is this host's own
 * projection and carries the optimistic edit, so retiring on it would throw
 * the intent away on the first frame after the send it was meant to outlive.
 * An accepted `moveTask` or `removeTask` naming the task is a newer
 * decision, and by the time this runs it has been written durably and the
 * account and host have been checked. Reordering is not: it moves a task
 * inside the group it is already in, and decides nothing about joining one.
 *
 * Every route - the menu, a new group, a drag - reaches this through the
 * same command, so there is nothing per-route to keep in step.
 */
function retireSupersededDraftIntents(action: OrganizationAction): void {
  if (action.kind !== "groups") return;
  const decided = new Set(
    action.operations.flatMap((operation) =>
      operation.operation === "moveTask" || operation.operation === "removeTask"
        ? [operation.taskId]
        : [],
    ),
  );
  if (decided.size === 0) return;
  const tabs = useEpicCanvasStore.getState();
  const customizations = useTabsStore.getState().customizations;
  for (const tabId of tabs.openTabOrder) {
    const task = tabs.tabsById[tabId];
    if (!task || !decided.has(task.epicId)) continue;
    if (!customizations?.[`epic:${tabId}`]?.pendingGroupId) continue;
    useTabsStore
      .getState()
      .setTabCustomization(
        { kind: "epic", id: tabId },
        { pendingGroupId: null },
      );
  }
}

/** One scope's draft-intent bookkeeping: attempts spent, and sends still out. */
interface DraftIntentTracking {
  readonly attempts: Map<string, number>;
  readonly inFlight: Set<string>;
}

function newDraftTracking(): DraftIntentTracking {
  return { attempts: new Map(), inFlight: new Set() };
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
