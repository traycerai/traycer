import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  NotificationsStreamClient,
  type NotificationsStreamCallbacks,
} from "@traycer-clients/shared/host-transport/notifications-stream-client";
import {
  acquireHostConnection,
  type HostConnectionLease,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { useHostStreamClientFor } from "@/hooks/host/use-host-stream-client-for";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import { EpicHostActivityStreams } from "./epic-host-activity-streams";
import {
  openNotificationsStream,
  useNotificationsStore,
} from "@/stores/notifications/notifications-store";
import {
  markAgentActivityReconnecting,
  openAgentActivityStream,
  useAgentActivityStore,
} from "@/stores/agent-activity-store";
import {
  openHostNotificationsStream,
  type HostNotificationsFeedFrame,
  useHostNotificationsStore,
} from "@/stores/notifications/host-notifications-store";
import {
  openCloudNotificationsStream,
  useCloudNotificationsStore,
} from "@/stores/notifications/cloud-notifications-store";
import { useNotificationFeedModeFor } from "@/lib/notifications/notification-feed-mode";
import { useStreamMethodSupportFor } from "@/lib/host/stream-runtime-context";
import { NotificationFeedModeContext } from "@/lib/notifications/notification-feed-mode-context";
import { resetCloudEntityReadDriver } from "@/lib/notifications/cloud-entity-read-driver";
import {
  readFocusedHostNotificationPresence,
  subscribeHostNotificationPresence,
  type FocusedHostNotificationPresence,
  type HostNotificationPresenceFrame,
} from "@/lib/notifications/notification-presence";
import { getNotificationsStreamFactoryOverride } from "@/providers/notifications-stream-factory-override";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useAuthService } from "@/lib/host";
import { useNotificationHost } from "@/hooks/notifications/use-notification-host";
import { useReactiveLocalHostEntry } from "@/hooks/host/use-reactive-local-host-entry";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { useNotificationShow } from "@/hooks/notifications/use-notifications";
import { useNotificationActivationWithNavigate } from "@/hooks/notifications/use-notification-activation";
import { useNotificationMarkEntityRead } from "@/hooks/notifications/use-notification-mark-entity-read-mutation";
import { useWindowsBridge } from "@/providers/windows-bridge-context";
import {
  displayCloudSnapshotArrivals,
  displayHostChannelEmission,
  playNotificationChime,
} from "@/lib/notifications/notification-display";
import {
  useAuthIdentityTransition,
  type AuthIdentityTransition,
} from "@/hooks/auth/use-auth-identity-transition";
import {
  clearNotificationIndicatorCaches,
  invalidateNotificationIndicators,
  invalidateNotificationIndicatorsForEntities,
} from "@/lib/notifications/notification-indicator-cache";
import {
  notificationEntitiesMatch,
  notificationEntityFromHostEntry,
  notificationPayloadBelongsToEntity,
  type NotificationNavigate,
} from "@/lib/notifications";
import { useAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";
import type {
  HostNotificationEntryV21,
  HostNotificationsEntityRef,
} from "@traycer/protocol/host/notifications/contracts";
import {
  useMergedNotificationsActions,
  type MergedNotificationRow,
} from "@/stores/notifications/merged-notifications";
import { activationResultHandler } from "@/lib/notifications/notification-activation-result";
import { occurrenceKeyForNotification } from "@/lib/notifications/notification-occurrence";

export interface NotificationsSessionProviderProps {
  readonly children: ReactNode;
  /** The live per-window router owns this provider's toast navigation. */
  readonly navigate: NotificationNavigate;
}

interface FocusedNotificationScope {
  readonly originHostId: string | null;
  readonly entity: HostNotificationsEntityRef;
}

/**
 * Whether an upsert for `entity` arriving from `hostId` names the
 * notification scope the user is LOOKING AT right now - the only case the
 * feed handler's terminal-severity auto-consume may fire for. A null origin
 * on the active scope means "not host-bound", which any host may match.
 */
function upsertTargetsActiveEntity(
  activeEntity: FocusedNotificationScope | null,
  hostId: string,
  entity: HostNotificationsEntityRef,
): boolean {
  if (activeEntity === null) return false;
  if (
    activeEntity.originHostId !== null &&
    activeEntity.originHostId !== hostId
  ) {
    return false;
  }
  return notificationEntitiesMatch(activeEntity.entity, entity);
}

/**
 * Mounted inside the app shell post-auth. Opens the notifications stream as
 * soon as the user is signed in and tears it down on sign-out / token
 * expiry. On sign-out - and on transitions between two distinct signed-in
 * users - the local notifications replica is reset so the incoming user
 * does not see the previous user's entries.
 *
 * Per the G8 decision, notifications always come from the **local host** -
 * never whichever host happens to be active in a composer/tab elsewhere in
 * the app. The stream is therefore bound to `useReactiveLocalHostEntry()` (a
 * transient, non-rebinding client via `useHostStreamClientFor`), not
 * `useAddressableHostId()` / the app-wide `useWsStreamClient()`. The cloud
 * feed rides the same local client: it is reached THROUGH a host, so binding
 * it anywhere else would reintroduce the active-host coupling G8 removed.
 */
export function NotificationsSessionProvider(
  props: NotificationsSessionProviderProps,
): ReactNode {
  const localHostEntry = useReactiveLocalHostEntry();
  const streamAuth = useStreamAuthRevalidator();
  const localStreamClient = useHostStreamClientFor(localHostEntry, streamAuth);
  // Negotiated against the client the streams are actually opened on, not the
  // app-wide active host - those differ whenever a tab is bound to a remote
  // host, and reading the remote manifest here selected mixed mode from one
  // host while consuming the other host's snapshots.
  const notificationFeedMode = useNotificationFeedModeFor(localStreamClient);
  // The session body itself consumes the mode (through
  // `useMergedNotificationsActions`), and a component cannot read a context it
  // renders. So the outer shell owns the negotiation and the provider, and the
  // body sits underneath it - taking the entry and client as props so the
  // transient stream client is built exactly once.
  return (
    <NotificationFeedModeContext.Provider value={notificationFeedMode}>
      <NotificationsSessionBody
        navigate={props.navigate}
        localHostEntry={localHostEntry}
        localStreamClient={localStreamClient}
        notificationFeedMode={notificationFeedMode}
      >
        {props.children}
      </NotificationsSessionBody>
    </NotificationFeedModeContext.Provider>
  );
}

interface NotificationsSessionBodyProps extends NotificationsSessionProviderProps {
  readonly localHostEntry: HostDirectoryEntry | null;
  readonly localStreamClient: IHostStreamClient<HostStreamRpcRegistry> | null;
  readonly notificationFeedMode: "local" | "cloud" | "upgrade-required";
}

function NotificationsSessionBody(
  props: NotificationsSessionBodyProps,
): ReactNode {
  const localHostEntry = props.localHostEntry;
  const localStreamClient = props.localStreamClient;
  const notificationFeedMode = props.notificationFeedMode;
  // Raw negotiation state, read beside the mode: `unknown` marks a client
  // whose handshake has not landed, which the stream-transition effect must
  // treat as "hold the previous projection", never as a downgrade decision.
  const cloudFeedSupport = useStreamMethodSupportFor(
    localStreamClient,
    "host.notifications.cloudFeed.subscribe",
  );
  const localHostId = localHostEntry?.hostId ?? null;
  const queryClient = useQueryClient();
  const authService = useAuthService();
  // Same cascade as the local streams' `onAuthError`, hoisted to a stable
  // identity so a remote activity stream is not torn down and reopened on
  // every render of this provider.
  const onRemoteActivityAuthError = useCallback((): void => {
    void authService.revalidateCurrentContext();
  }, [authService]);
  // The NOTIFICATION host's own client - the same resolver every other
  // downstream consumer of these streams uses, so the canceller below and the
  // frames driving it name one machine by construction.
  //
  // It is a CANCELLER, and that is why it cannot be the app-wide client:
  // `invalidateNotificationIndicators` releases the in-flight
  // `host.notifications.indicatorState` read sitting behind the queries it
  // invalidates, and those reads went out on this host's client
  // (`useHostNotificationIndicators` resolves the notification host too). The
  // coordinator keys a cancellation by `(hostId, userId, method, params)` and
  // `HostClient.cancelActiveReadFor` takes the host from the CLIENT, not from
  // the `hostId` argument beside it - so the app-wide client cancelled under
  // whichever host was effective. While a tab was bound to a remote host that
  // left the local host's coordinated read running, to re-resolve the
  // just-invalidated query with its pre-frame answer, and cancelled the remote
  // host's identical read for a frame that was never about it.
  const notificationHostClient = useNotificationHost().client;
  const showNotification = useNotificationShow();
  const { activate } = useNotificationActivationWithNavigate(props.navigate);
  const mergedActions = useMergedNotificationsActions();
  const windowsBridge = useWindowsBridge();
  const status = useAuthStore((state) => state.status);
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const disposerRef = useRef<(() => void) | null>(null);
  const activityDisposerRef = useRef<(() => void) | null>(null);
  const hostDisposerRef = useRef<(() => void) | null>(null);
  const cloudDisposerRef = useRef<(() => void) | null>(null);
  // The stream client all notification streams were opened against. Stream
  // ownership follows the client instance: when the provider context serves a
  // different client (the app-wide liveness rebuild, or any same-identity
  // replacement), the old client's sessions are already dead, so the streams
  // must be torn down and reopened against the new client.
  const openedStreamClientRef =
    useRef<IHostStreamClient<HostStreamRpcRegistry> | null>(null);
  const previousStreamClientRef =
    useRef<IHostStreamClient<HostStreamRpcRegistry> | null>(localStreamClient);
  const previousLocalHostIdRef = useRef<string | null>(localHostId);
  // Start unset so an initially cloud-capable session also clears the legacy
  // local sources before opening its first relay stream.
  const previousFeedModeRef = useRef<
    "local" | "cloud" | "upgrade-required" | null
  >(null);
  const [fallbackWindowId] = useState(createFallbackNotificationsWindowId);
  const windowId = windowsBridge?.windowId ?? fallbackWindowId;
  const markEntityReadMutation = useNotificationMarkEntityRead();
  const markEntityRead = markEntityReadMutation.mutate;
  const activeEntityRef = useRef<FocusedNotificationScope | null>(null);
  // Notification-feed delivery is independent from the live chat stream. A
  // newly observed row may describe an older turn that replicated late, so it
  // cannot causally consume a renderer-local transport failure. Seed every
  // completion into the durable replay ledger only; the live
  // `turn.completed` event acknowledges app-local failures at the chat-store
  // boundary where ordering is authoritative.
  const recordCompletions = useCallback(
    (
      inputs: ReadonlyArray<{
        readonly entry: HostNotificationEntryV21;
        readonly originHostId: string;
        readonly semanticId: string;
      }>,
    ): void => {
      const observedAt = Date.now();
      useAppLocalNotificationsStore.getState().recordCompletions(
        inputs.flatMap(({ entry, originHostId, semanticId }) => {
          if (entry.severity !== "done") return [];
          const entity = notificationEntityFromHostEntry(entry);
          if (entity === null) return [];
          return [
            {
              originHostId,
              completion: {
                id: semanticId,
                occurrenceKey: occurrenceKeyForNotification({
                  feedId: semanticId,
                  createdAt: entry.updatedAt,
                  sourceRef: entry.sourceRef,
                }),
              },
              entity: null,
              observedAt,
            },
          ];
        }),
      );
    },
    [],
  );
  const removeObservedCompletions = useCallback(
    (originHostId: string, completionIds: ReadonlyArray<string>): void => {
      useAppLocalNotificationsStore
        .getState()
        .removeObservedCompletions(originHostId, completionIds);
    },
    [],
  );
  const onToastClick = useCallback(
    (row: MergedNotificationRow): void => {
      if (row.payload === null) return;
      activate({
        payload: row.payload,
        receivedAt: row.createdAt,
        feedId: row.feedId,
        originHostId: row.originHostId,
        onResult: activationResultHandler({
          row,
          feedId: row.feedId,
          surface: "toast",
          markAsRead: mergedActions.markAsRead,
          onSuccess: null,
        }),
      });
    },
    [activate, mergedActions],
  );
  const onToastClickRef = useRef(onToastClick);
  useEffect(() => {
    onToastClickRef.current = onToastClick;
  }, [onToastClick]);
  // The merged actions are rebuilt whenever any cloud mutation's state
  // changes. Reading the fan-out through a ref keeps the two cloud effects
  // below subscribed for the life of the mode instead of tearing down and
  // resubscribing on every in-flight mark-read - which would leave a window
  // where an arriving snapshot has no listener.
  const markCloudEntityReadRef = useRef(mergedActions.markEntityAsRead);
  useEffect(() => {
    markCloudEntityReadRef.current = mergedActions.markEntityAsRead;
  }, [mergedActions]);
  const markCloudEntityRead = useCallback(
    (scope: FocusedNotificationScope): void => {
      markCloudEntityReadRef.current(scope.originHostId, scope.entity);
    },
    [],
  );
  const consumeEntity = useCallback(
    (scope: FocusedNotificationScope): void => {
      // App-local rows are client-side state owned by neither feed, so this
      // half runs identically in both modes.
      useAppLocalNotificationsStore
        .getState()
        .markEntityAsRead(scope.originHostId, scope.entity, Date.now());
      // BOTH calls in mixed mode, and no early return between them. The host
      // feed is the exact local durable-home partition while the cloud fan-out
      // covers its complement, so each addresses rows the other cannot: an
      // early return after the cloud call left every local-homed row unread.
      //
      // The host-binding guard still applies to the local half. The local
      // notification RPC addresses the CONNECTED host, so a tile bound to
      // another host must not acknowledge the same entity there.
      if (scope.originHostId === null || scope.originHostId === localHostId) {
        markEntityRead(scope.entity);
      }
      if (notificationFeedMode === "cloud") {
        markCloudEntityRead(scope);
      }
    },
    [localHostId, markEntityRead, markCloudEntityRead, notificationFeedMode],
  );
  const onPresenceChanged = useCallback(
    (frame: HostNotificationPresenceFrame, hostId: string): void => {
      if (localHostId !== hostId) return;
      const nextEntity = frame.focused
        ? scopeFromFocusedPresence(readFocusedHostNotificationPresence())
        : null;
      const previousEntity = activeEntityRef.current;
      if (
        (nextEntity === null && previousEntity === null) ||
        (nextEntity !== null &&
          previousEntity !== null &&
          focusedNotificationScopesMatch(nextEntity, previousEntity))
      )
        return;
      activeEntityRef.current = nextEntity;
      if (nextEntity !== null) consumeEntity(nextEntity);
    },
    [localHostId, consumeEntity],
  );
  const onFeedFrame = useCallback(
    (frame: HostNotificationsFeedFrame, hostId: string): void => {
      if (localHostId !== hostId) return;
      // `partitionSnapshot` is a `snapshot` for every purpose here: `@1.2`
      // defines it by extending the frozen V11 snapshot, so it carries the
      // same `attention` / `recent` pages and only narrows WHICH rows they
      // hold. Omitting it would drop completion receipts for the whole local
      // partition on every mixed-mode session.
      if (frame.kind === "snapshot" || frame.kind === "partitionSnapshot") {
        invalidateNotificationIndicators(
          queryClient,
          hostId,
          notificationHostClient,
        );
        recordCompletions(
          [...frame.attention.entries, ...frame.recent.entries].map(
            (entry) => ({
              entry,
              originHostId: hostId,
              semanticId: entry.id,
            }),
          ),
        );
        return;
      }
      if (frame.kind === "cleared" || frame.kind === "removed") {
        removeObservedCompletions(hostId, frame.removedIds);
        invalidateNotificationIndicators(
          queryClient,
          hostId,
          notificationHostClient,
        );
        return;
      }
      if (frame.kind === "readStateChanged") {
        removeObservedCompletions(hostId, frame.removedIds);
        // A read-state frame can also carry retention `removedIds` for
        // unrelated rows the protocol has no entity refs for - full-invalidate
        // rather than leave those entities' indicators stale.
        if (frame.removedIds.length > 0) {
          invalidateNotificationIndicators(
            queryClient,
            hostId,
            notificationHostClient,
          );
        } else {
          invalidateNotificationIndicatorsForEntities(
            queryClient,
            hostId,
            frame.entityRefs,
            notificationHostClient,
          );
        }
        return;
      }
      const entity = notificationEntityFromHostEntry(frame.entry);
      removeObservedCompletions(hostId, frame.removedIds);
      // Same reasoning as above: a surviving upsert's `removedIds` can name
      // entities this frame carries no ref for.
      if (frame.removedIds.length > 0) {
        invalidateNotificationIndicators(
          queryClient,
          hostId,
          notificationHostClient,
        );
      } else if (entity !== null) {
        invalidateNotificationIndicatorsForEntities(
          queryClient,
          hostId,
          [entity],
          notificationHostClient,
        );
      }
      if (entity === null) return;
      recordCompletions([
        {
          entry: frame.entry,
          originHostId: hostId,
          semanticId: frame.entry.id,
        },
      ]);
      if (!upsertTargetsActiveEntity(activeEntityRef.current, hostId, entity)) {
        return;
      }
      const isTerminalSeverity =
        frame.entry.severity === "done" || frame.entry.severity === "failure";
      if (!isTerminalSeverity) return;
      consumeEntity({ originHostId: hostId, entity });
    },
    [
      localHostId,
      consumeEntity,
      recordCompletions,
      removeObservedCompletions,
      notificationHostClient,
      queryClient,
    ],
  );
  const onHostStreamOpened = useCallback((): void => {
    activeEntityRef.current = null;
  }, []);

  const hostConnectionRef = useRef<HostConnectionLease | null>(null);

  const tearDown = useCallback((): void => {
    openedStreamClientRef.current = null;
    // Release this host's connection lease LAST-ish but unconditionally: the
    // lease is ref-counted with a keep-warm linger, so dropping it here lets
    // the registry retire the host's bookkeeping when nothing else holds it,
    // while a prompt re-open (a mode flip, a re-mount) adopts it warm.
    if (hostConnectionRef.current !== null) {
      const lease = hostConnectionRef.current;
      hostConnectionRef.current = null;
      lease.release();
    }
    if (disposerRef.current !== null) {
      const disposer = disposerRef.current;
      disposerRef.current = null;
      disposer();
    }
    if (activityDisposerRef.current !== null) {
      const disposer = activityDisposerRef.current;
      activityDisposerRef.current = null;
      disposer();
    }
    if (hostDisposerRef.current !== null) {
      const disposer = hostDisposerRef.current;
      hostDisposerRef.current = null;
      disposer();
    }
    if (cloudDisposerRef.current !== null) {
      const disposer = cloudDisposerRef.current;
      cloudDisposerRef.current = null;
      disposer();
    }
  }, []);

  // The relay session's rows and its view-consumption bookkeeping are one
  // unit of ownership: the driver holds an in-flight claim and a retry timer
  // that would otherwise outlive the snapshot they were derived from and fire
  // against the next session's feed.
  const resetCloudRelaySession = useCallback((): void => {
    useCloudNotificationsStore.getState().reset();
    resetCloudEntityReadDriver();
  }, []);

  // Identity/sign-out owns the full reset: every user-owned replica (host,
  // collaboration) is cleared so the incoming user never sees the prior
  // user's entries.
  const resetIdentityReplica = useCallback((): void => {
    activeEntityRef.current = null;
    useNotificationsStore.getState().reset();
    useAgentActivityStore.getState().reset();
    useHostNotificationsStore.getState().reset();
    resetCloudRelaySession();
    clearNotificationIndicatorCaches(queryClient);
  }, [queryClient, resetCloudRelaySession]);

  // A host switch only invalidates host-owned truth. Collaboration/system
  // rows are not scoped to a host and must survive the swap untouched.
  const resetHostReplica = useCallback(
    (departedHostId: string): void => {
      activeEntityRef.current = null;
      useHostNotificationsStore.getState().reset();
      // Scoped to the slice that actually departed. The map holds a slice per
      // host, so the old whole-map reset erased still-open REMOTE streams'
      // activity whenever any slice happened to be local-served (and kept the
      // departed slice when it was not). Those remote streams do not resend
      // their state merely because this store was cleared, so running agents
      // vanished - or a dead host's agents lingered - until the next frame.
      useAgentActivityStore.getState().resetHost(departedHostId);
      resetCloudRelaySession();
      clearNotificationIndicatorCaches(queryClient);
    },
    [queryClient, resetCloudRelaySession],
  );

  // The host replica alone, for a change of PROJECTION rather than of host.
  // Deliberately narrower than `resetHostReplica`: the agent-activity slice is
  // keyed by host and says nothing about notification home partitions, so
  // wiping it here would blank running agents for a feed-mode flip. The
  // indicator caches DO go, because their `home` selector moves with the mode.
  const resetHostProjection = useCallback((): void => {
    activeEntityRef.current = null;
    useHostNotificationsStore.getState().reset();
    clearNotificationIndicatorCaches(queryClient);
  }, [queryClient]);

  // Cloud rows are a relay-session snapshot, not a durable replica. A lost
  // binding or replacement stream client starts a new ownership epoch and
  // stays non-authoritative while the new relay connects and delivers its own
  // snapshot.
  const resetCloudRelayOwnership = useCallback((): void => {
    resetCloudRelaySession();
  }, [resetCloudRelaySession]);

  // A disconnect (IPC drop / host restart) is not a truth reset: rendered
  // host rows and cursors stay put, and only the exact summary degrades to
  // unknown until a fresh atomic snapshot lands on reconnect.
  const markHostReplicaDisconnected = useCallback((): void => {
    activeEntityRef.current = null;
    useHostNotificationsStore.getState().setConnectionStatus("connecting");
    useCloudNotificationsStore.getState().setConnectionState("reconnecting");
    markAgentActivityReconnecting();
  }, []);

  // StrictMode mounts, cleans up, then re-mounts effects. Returning Zustand's
  // unsubscribe means exactly one live app-local listener survives that cycle;
  // it always reads the current ref and callback rather than a stale snapshot.
  useEffect(() => {
    return useAppLocalNotificationsStore.subscribe((state, previous) => {
      const activeEntity = activeEntityRef.current;
      if (activeEntity === null) return;
      const hasUnreadArrivalForActiveEntity = Object.values(state.byId).some(
        (entry) => {
          if (entry.readAt !== null) return false;
          const prior = Object.hasOwn(previous.byId, entry.id)
            ? previous.byId[entry.id]
            : null;
          const isNewUnreadOccurrence = prior === null || prior.readAt !== null;
          return (
            isNewUnreadOccurrence &&
            (entry.originHostId ?? null) === activeEntity.originHostId &&
            notificationPayloadBelongsToEntity(
              entry.payload,
              activeEntity.entity,
            )
          );
        },
      );
      if (hasUnreadArrivalForActiveEntity) {
        consumeEntity(activeEntity);
      }
    });
  }, [consumeEntity]);

  // TRIGGER 1 (cloud) - presence change.
  //
  // Local mode learns "the user is looking at X" from host presence frames,
  // and neither local stream is opened in cloud mode. But those frames are
  // built from state this renderer already owns: the canvas store plus
  // document focus. `readFocusedHostNotificationPresence` is literally
  // the function the outgoing frame is composed from, and
  // `subscribeHostNotificationPresence` already watches exactly the inputs
  // that can change it. Reading it directly is the same signal one hop
  // earlier - no stream reopened to be told what this window already knows.
  useEffect(() => {
    if (notificationFeedMode !== "cloud") return;
    const evaluate = (): void => {
      const nextEntity = scopeFromFocusedPresence(
        readFocusedHostNotificationPresence(),
      );
      const previousEntity = activeEntityRef.current;
      if (
        (nextEntity === null && previousEntity === null) ||
        (nextEntity !== null &&
          previousEntity !== null &&
          focusedNotificationScopesMatch(nextEntity, previousEntity))
      )
        return;
      activeEntityRef.current = nextEntity;
      if (nextEntity !== null) consumeEntity(nextEntity);
    };
    evaluate();
    return subscribeHostNotificationPresence(evaluate);
  }, [notificationFeedMode, consumeEntity]);

  // TRIGGER 2 (cloud) - a row arriving for the entity already in view.
  //
  // The local counterpart is the terminal-severity branch of `onFeedFrame`.
  // Cloud rows arrive only as whole snapshots, so the equivalent is to
  // re-evaluate consumption whenever the row set changes. The severity filter
  // and the convergence guard both live in the fan-out itself, which writes
  // nothing when it has no targets - so this cannot drive a mark -> snapshot
  // -> mark loop, and a server that never takes the marker still gets at most
  // one request per entry per session.
  useEffect(() => {
    if (notificationFeedMode !== "cloud") return;
    return useCloudNotificationsStore.subscribe((state, previous) => {
      if (state.rows === previous.rows) return;
      const activeEntity = activeEntityRef.current;
      if (activeEntity === null) return;
      markCloudEntityRead(activeEntity);
    });
  }, [notificationFeedMode, markCloudEntityRead]);

  const openForCurrentUser = useCallback(
    (settledFeedMode: "local" | "cloud" | "upgrade-required"): void => {
      if (
        getNotificationsStreamFactoryOverride() === null &&
        localStreamClient === null
      ) {
        return;
      }
      // Same recovery contract as EpicSessionProvider: an `UNAUTHORIZED`
      // terminal close means the host couldn't accept the current context
      // bearer. Re-validate against AuthnV3 so the cascade either rotates the
      // context credentials (transient) or tears the session down via sign-out.
      const onAuthError = (): void => {
        void authService.revalidateCurrentContext();
      };
      const onEntitlementDenied = (): void => {
        // Dormant defense for a future server-side entitlement gate: preserve a
        // defined unavailable wall and revalidate auth instead of leaving the
        // session in an unclassified terminal state.
        useAuthStore.getState().setSubscriptionStatus("FREE");
        void authService.revalidateCurrentContext();
      };
      if (localHostId === null) return;
      const streamHostId = localHostId;
      // ONE reconnect policy for this host, handed to every stream opened
      // below (redesign P4.1 / connection-registry §6). This is the single
      // wiring point for all of them, which is exactly why the acquisition
      // belongs here: each store constructing its own scheduler was the
      // scattered ownership the consolidation removes. Each store still opens
      // its OWN lane off it, so their backoffs stay independent.
      const hostConnection = acquireHostConnection(streamHostId);
      hostConnectionRef.current = hostConnection;
      const reconnect = hostConnection.reconnect;
      openedStreamClientRef.current = localStreamClient;
      const createNotificationsStream = (
        callbacks: NotificationsStreamCallbacks,
      ) => {
        const override = getNotificationsStreamFactoryOverride();
        if (override !== null) {
          return override(callbacks);
        }
        if (localStreamClient === null) {
          throw new Error(
            "NotificationsSessionProvider: local host stream client missing at open time.",
          );
        }
        return new NotificationsStreamClient({
          wsStreamClient: localStreamClient,
          callbacks,
        });
      };
      // Host-selected activity planes (#906) replaced the notifications-room
      // awareness reader that used to carry agent-activity presence, and moved it
      // out of the cloud-only branch. Ours contributed only the local-host pin, so
      // this takes that structure with `localStreamClient`: agent activity is
      // read from the LOCAL host's stream, never a remote one.
      if (localStreamClient !== null) {
        activityDisposerRef.current = openAgentActivityStream(
          streamHostId,
          reconnect,
          localStreamClient,
          onAuthError,
        );
      }
      if (settledFeedMode === "cloud") {
        if (localStreamClient === null) return;
        // The cloud feed owns host/agent rows only. Collaboration events are
        // still written to the per-user Notifications room, so cloud mode must
        // keep that replica live alongside the relay or sharing notifications
        // disappear after the mode-transition reset below.
        disposerRef.current = openNotificationsStream(
          reconnect,
          createNotificationsStream,
          onAuthError,
        );
        cloudDisposerRef.current = openCloudNotificationsStream(
          reconnect,
          localStreamClient,
          onAuthError,
          onEntitlementDenied,
          ({ rows, arrivals }) => {
            recordCompletions(
              rows.map((row) => ({
                entry: row.entry,
                originHostId: row.originHostId,
                semanticId: row.entryId,
              })),
            );
            displayCloudSnapshotArrivals(arrivals, {
              showNotification,
              playChime: playNotificationChime,
              onToastClick: (row) => onToastClickRef.current(row),
            });
          },
        );
      }
      if (settledFeedMode === "upgrade-required") {
        useCloudNotificationsStore.getState().setConnectionState("unavailable");
        return;
      }
      // Every transport session starts with a baseline snapshot. Keep durable,
      // bounded receipts for replay bookkeeping, but never treat a row from
      // this independently ordered feed as causal evidence over a renderer-local
      // failure.
      //
      // LOCAL MODE ONLY. This opens the legacy whole-origin Yjs replica
      // (`useNotificationsStore`), which mixed mode does not read: there the
      // local lane comes from the per-host store that `openHostNotificationsStream`
      // below fills, and `merged-notifications` concatenates that with the cloud
      // rows. The completion receipts are unaffected - they are recorded in
      // `onFeedFrame`, which belongs to the host stream and runs in both modes -
      // so opening this one in mixed mode would be a second subscription whose
      // rows nothing reads.
      if (settledFeedMode === "local") {
        disposerRef.current = openNotificationsStream(
          reconnect,
          createNotificationsStream,
          onAuthError,
        );
      }
      if (
        hostDisposerRef.current === null &&
        getNotificationsStreamFactoryOverride() === null &&
        localStreamClient !== null
      ) {
        hostDisposerRef.current = openHostNotificationsStream(
          reconnect,
          localStreamClient,
          onAuthError,
          {
            windowId,
            now: () => Date.now(),
            displayChannelEmission: (entries) => {
              displayHostChannelEmission(
                entries,
                {
                  showNotification,
                  playChime: playNotificationChime,
                  onToastClick: (row) => onToastClickRef.current(row),
                },
                streamHostId,
              );
            },
            onFeedFrame: (frame) => onFeedFrame(frame, streamHostId),
            onPresenceChanged: (frame) =>
              onPresenceChanged(frame, streamHostId),
            onStreamOpened: onHostStreamOpened,
          },
        );
      }
    },
    [
      localStreamClient,
      authService,
      recordCompletions,
      localHostId,
      windowId,
      showNotification,
      onFeedFrame,
      onPresenceChanged,
      onHostStreamOpened,
    ],
  );

  // Auth identity transitions own the replica-reset responsibility: sign-out
  // and user-switch both require wiping the prior-user Y.Doc before the next
  // `openForCurrentUser()` lands a fresh snapshot over empty state.
  const onAuthTransition = useCallback(
    (transition: AuthIdentityTransition) => {
      if (
        transition.kind === "signedOut" ||
        transition.kind === "userSwitched"
      ) {
        tearDown();
        resetIdentityReplica();
      }
    },
    [tearDown, resetIdentityReplica],
  );
  // Canonical `contextMetadata.userId`, not `profile.email` - two distinct
  // accounts can share an email, and an email-keyed comparison would then
  // misclassify a genuine user switch as an idle re-render, leaving the
  // outgoing user's collaboration/host rows visible to the incoming one.
  useAuthIdentityTransition(status, userId, onAuthTransition);

  // Open / reopen the stream on signed-in + local-host-client transitions.
  // `localStreamClient` flips to `null` when there is no local host (browser/
  // mobile shells) or the local host's IPC channel drops - we teardown so the
  // next reconnect lands on a fresh client. It becomes a NEW object when the
  // local host respawns at a fresh endpoint under the SAME `hostId`
  // (`useHostStreamClientFor` rebuilds the transport on an endpoint move) -
  // that reference change, not a `hostId` comparison, is what drives
  // teardown/reopen here, so a respawn is followed even though "the local
  // host" identity never changed. Switching the app-wide ACTIVE host leaves
  // `localStreamClient` untouched, so this effect intentionally does not
  // re-run for that transition (per the G8 decision). A disconnect preserves
  // host rows and cursors - only the summary degrades to unknown until a
  // replacement snapshot lands; a genuine local-host identity change is what
  // resets the host replica.
  useEffect(() => {
    const isSignedIn = status === "signed-in";
    const priorStreamClient = previousStreamClientRef.current;
    previousStreamClientRef.current = localStreamClient;

    if (!isSignedIn) {
      // `useAuthIdentityTransition`'s onTransition already tore down on the
      // signedOut path; no-op here.
      return;
    }
    // Keyed on the HOST, not the client: `useHostStreamClientFor` returns a
    // client exactly when it is given an entry, so in production these two are
    // the same condition - but the test stream-factory override supplies a
    // stream with no client at all, and gating on the client would make that
    // path unreachable. Client identity still matters below, for the respawn
    // case where both sides are non-null.
    if (localHostId === null) {
      tearDown();
      resetCloudRelayOwnership();
      markHostReplicaDisconnected();
      return;
    }
    // Two independent ways the replica goes stale, and each needs its own ref
    // because neither sees the other's case:
    //
    //  - CLIENT SWAP (both sides non-null): the local host respawned at a
    //    fresh endpoint, so it is a NEW host process with new notification
    //    state - the old rows must not survive into it.
    //  - HOST SWITCH ACROSS A DISCONNECT (A -> null -> B): the disconnect
    //    already nulled `previousStreamClientRef`, so the client comparison
    //    above sees nothing. `previousLocalHostIdRef` is updated only on a
    //    non-null host, so it still spans the gap. A -> null -> A stays a
    //    reconnect (rows and cursors are preserved, the re-landed snapshot
    //    refreshes them); A -> null -> B resets before B's stream opens, or
    //    B's snapshot would land on A's stale rows for one render.
    const priorLocalHostId = previousLocalHostIdRef.current;
    previousLocalHostIdRef.current = localHostId;
    const clientSwapped =
      priorStreamClient !== null && priorStreamClient !== localStreamClient;
    const hostSwitchedAcrossDisconnect =
      priorLocalHostId !== null && priorLocalHostId !== localHostId;
    if (clientSwapped || hostSwitchedAcrossDisconnect) {
      tearDown();
      // Across a switch the departed slice is the PRIOR host; a client swap
      // keeps the same host id, so that slice is the one being replaced.
      resetHostReplica(priorLocalHostId ?? localHostId);
    }
    // The mode this pass DECIDES on. A rebuilt stream client reports every
    // method's support as `unknown` until its handshake lands, so the raw
    // negotiation reads `local` for a beat even when the same cloud-capable
    // host is coming right back. That beat is "not yet re-decided", not a
    // capability downgrade: deciding on it would tear the mixed projection
    // down (discarding the retained local-partition rows the disconnect path
    // deliberately preserves), open the whole-origin feed, then reset again
    // when negotiation lands. Hold the previously decided projection until
    // the client actually answers.
    const settledFeedMode =
      cloudFeedSupport === "unknown" && previousFeedModeRef.current !== null
        ? previousFeedModeRef.current
        : notificationFeedMode;
    if (previousFeedModeRef.current !== settledFeedMode) {
      // A CHANGE of projection, not the first read of one. The ref starts
      // `null` so the initial pass always lands here, but there is no prior
      // question for those rows to have been answered under - and a replica
      // retained across a remount (an offline client whose capability is still
      // pending) is exactly what must survive.
      const projectionChanged = previousFeedModeRef.current !== null;
      previousFeedModeRef.current = settledFeedMode;
      tearDown();
      // The cloud relay is session-owned and must restart across a capability
      // change. The local feed is re-subscribed in both modes, so the STREAM
      // survives the transition - but its accumulated rows and cursors do not.
      //
      // What changes across this boundary is what those rows MEAN. Local mode
      // asks the host for its whole origin; mixed mode asks for the exact
      // `home: local` partition. The retained replica was filled under the old
      // question and is read under the new one, so a local->mixed flip
      // reinterprets whole-origin rows as the local partition and the arriving
      // cloud snapshot double-counts every cloud-homed replica among them
      // until a fresh partition snapshot lands - indefinitely, if that stream
      // is slow or offline. Dropping the replica makes the window a brief
      // empty rather than a confidently wrong merge.
      if (projectionChanged) resetHostProjection();
      // A cloud-to-local capability change must never leave cloud rows on
      // screen. Renderer-local failure rows survive either direction because
      // no host or cloud feed can reproduce them.
      resetCloudRelaySession();
      // Entering either cloud-facing state also discards the retained v1 room
      // replica: the collaboration stream reopens in cloud mode and lands its
      // own baseline snapshot, and global rows are part of the merged feed's
      // local lane now - retained pre-transition rows would render as current
      // until that baseline arrived.
      if (settledFeedMode !== "local") {
        useNotificationsStore.getState().reset();
      }
    }
    // A replaced stream client under the SAME host + user (the app-wide
    // liveness rebuild after the client was closed underneath the provider)
    // closes the old client's sessions, so both notification streams must
    // rebind to the new client. The identity did not change, so the replica
    // is kept - the re-landed snapshot merges into the same doc.
    // Evaluated twice on purpose, not hoisted: the second read must see the
    // effect of the `tearDown()` immediately below it.
    const openStreams = [
      disposerRef,
      activityDisposerRef,
      hostDisposerRef,
      cloudDisposerRef,
    ];
    if (
      anyStreamOpen(openStreams) &&
      openedStreamClientRef.current !== localStreamClient
    ) {
      tearDown();
      resetCloudRelayOwnership();
    }
    if (!anyStreamOpen(openStreams)) {
      openForCurrentUser(settledFeedMode);
    }
  }, [
    localHostId,
    status,
    userId,
    localStreamClient,
    tearDown,
    resetHostReplica,
    resetHostProjection,
    resetCloudRelayOwnership,
    resetCloudRelaySession,
    markHostReplicaDisconnected,
    openForCurrentUser,
    notificationFeedMode,
    cloudFeedSupport,
  ]);

  useEffect(() => {
    return () => {
      tearDown();
      // `tearDown` only closes streams. The view-consumption driver keeps its
      // own re-arming retry timer, and unmount is the one teardown edge that
      // reaches none of the `resetCloudRelaySession` call sites - so without
      // this, a failing server's retry chain outlives the provider.
      resetCloudEntityReadDriver();
    };
  }, [tearDown]);

  // Rendered, not opened inline: each remote host's stream client comes from
  // a hook, and hooks cannot be called per item of a changing list. The local
  // host's activity stream stays above, on the G8 local-host pin.
  return (
    <>
      <EpicHostActivityStreams
        localHostId={localHostId}
        onAuthError={onRemoteActivityAuthError}
      />
      {props.children}
    </>
  );
}

/**
 * True when this provider still holds any of its streams open.
 *
 * Extracted because the reopen effect tests the same set twice - once as "any
 * open" and once as "none open" - and the activity disposer (host-selected
 * activity planes) made each of those a four-term boolean, pushing the effect
 * past the complexity ceiling. Structurally typed over `{ current }` so it
 * takes ref objects without this module depending on React's ref types.
 */
function anyStreamOpen(
  refs: readonly { readonly current: (() => void) | null }[],
): boolean {
  return refs.some((ref) => ref.current !== null);
}

function scopeFromFocusedPresence(
  focused: FocusedHostNotificationPresence | null,
): FocusedNotificationScope | null {
  if (focused === null || focused.entity.epicId === undefined) return null;
  return {
    originHostId: focused.originHostId,
    entity:
      focused.entity.chatId === undefined
        ? { epicId: focused.entity.epicId }
        : {
            epicId: focused.entity.epicId,
            chatId: focused.entity.chatId,
          },
  };
}

function focusedNotificationScopesMatch(
  left: FocusedNotificationScope,
  right: FocusedNotificationScope,
): boolean {
  return (
    left.originHostId === right.originHostId &&
    notificationEntitiesMatch(left.entity, right.entity)
  );
}

function createFallbackNotificationsWindowId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi.randomUUID === "function") {
    return `browser:${cryptoApi.randomUUID()}`;
  }
  return `browser:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
