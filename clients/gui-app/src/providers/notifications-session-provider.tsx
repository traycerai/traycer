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
import { useHostStreamClientBindingFor } from "@/hooks/host/use-host-stream-client-for";
import { useHostClientFor } from "@/hooks/host/use-host-client-for";
import { remoteAwareOwnerIdentityKey } from "@/lib/host/transport-key";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import {
  openNotificationsStream,
  useNotificationsStore,
} from "@/stores/notifications/notifications-store";
import {
  noteAgentActivityConnectionStatus,
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
import { useNotificationFeedMode } from "@/lib/notifications/notification-feed-mode";
import { resetCloudEntityReadDriver } from "@/lib/notifications/cloud-entity-read-driver";
import {
  readFocusedHostNotificationPresence,
  subscribeHostNotificationPresence,
  type FocusedHostNotificationPresence,
  type HostNotificationPresenceFrame,
} from "@/lib/notifications/notification-presence";
import { getNotificationsStreamFactoryOverride } from "@/providers/notifications-stream-factory-override";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useAuthService, useHostClient } from "@/lib/host";
import { useNotificationsServingHostEntry } from "@/hooks/host/use-notifications-serving-host-entry";
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
  notificationEntityFromPayload,
  notificationEntityMatchesPresence,
  type NotificationNavigate,
} from "@/lib/notifications";
import { useAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";
import type {
  HostNotificationEntryV22,
  HostNotificationsEntityRef,
} from "@traycer/protocol/host/notifications/contracts";
import {
  useMergedNotificationsActions,
  type MergedNotificationRow,
} from "@/stores/notifications/merged-notifications";
import { activationResultHandler } from "@/lib/notifications/notification-activation-result";
import { occurrenceKeyForNotification } from "@/lib/notifications/notification-occurrence";
import { NotificationConsumptionContext } from "@/components/notifications/notification-consumption-context";
import { installNotificationChimeAudioWarmup } from "@/lib/notifications/notification-chime";

export interface NotificationsSessionProviderProps {
  readonly children: ReactNode;
  /** The live per-window router owns this provider's toast navigation. */
  readonly navigate: NotificationNavigate;
}

interface FocusedNotificationScope {
  readonly originHostId: string | null;
  readonly entity: HostNotificationsEntityRef;
}

/** Post-auth notifications stream. Reset the replica on sign-out and on user change. Bind every stream to the serving host (`useHostStreamClientBindingFor`), never the app-wide client. */
export function NotificationsSessionProvider(
  props: NotificationsSessionProviderProps,
): ReactNode {
  useEffect(() => installNotificationChimeAudioWarmup(), []);
  const queryClient = useQueryClient();
  const authService = useAuthService();
  const hostClient = useHostClient();
  const servingHostEntry = useNotificationsServingHostEntry();
  const streamAuth = useStreamAuthRevalidator();
  const streamBinding = useHostStreamClientBindingFor(
    servingHostEntry,
    streamAuth,
  );
  const servingHostId = servingHostEntry?.hostId ?? null;
  // Unary acknowledgements share the stream's serving-host binding. The app-wide effective host can still be unresolved when this stream opens.
  const servingHostClient = useHostClientFor(servingHostEntry);
  // Serving-host change lands one commit before its transport. Prove freshness by ownership, not liveness: a released remote client can still subscribe.
  const servingOwnerIdentity = remoteAwareOwnerIdentityKey(
    servingHostEntry,
    hostClient.getRequestContextUserId(),
  );
  const servingStreamClient =
    streamBinding !== null &&
    servingOwnerIdentity !== null &&
    streamBinding.transportKey === servingOwnerIdentity
      ? streamBinding.client
      : null;
  const showNotification = useNotificationShow();
  const { activate } = useNotificationActivationWithNavigate(props.navigate);
  const mergedActions = useMergedNotificationsActions();
  const windowsBridge = useWindowsBridge();
  const status = useAuthStore((state) => state.status);
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const notificationFeedMode = useNotificationFeedMode();
  const disposerRef = useRef<(() => void) | null>(null);
  const activityDisposerRef = useRef<(() => void) | null>(null);
  const hostDisposerRef = useRef<(() => void) | null>(null);
  const cloudDisposerRef = useRef<(() => void) | null>(null);
  // Stream ownership follows the client instance: a replacement client means tear down and reopen.
  const openedStreamClientRef =
    useRef<IHostStreamClient<HostStreamRpcRegistry> | null>(null);
  const previousStreamClientRef =
    useRef<IHostStreamClient<HostStreamRpcRegistry> | null>(
      servingStreamClient,
    );
  const previousServingHostIdRef = useRef<string | null>(servingHostId);
  // Start unset so an initially cloud-capable session also clears legacy local sources.
  const previousFeedModeRef = useRef<
    "local" | "cloud" | "upgrade-required" | null
  >(null);
  const [fallbackWindowId] = useState(createFallbackNotificationsWindowId);
  const windowId = windowsBridge?.windowId ?? fallbackWindowId;
  const markEntityReadMutation =
    useNotificationMarkEntityRead(servingHostClient);
  const markEntityRead = markEntityReadMutation.mutate;
  const activeEntityRef = useRef<FocusedNotificationScope | null>(null);
  // Seed completions into the replay ledger only. A late-replicated row cannot
  // consume a renderer-local transport failure.
  const recordCompletions = useCallback(
    (
      inputs: ReadonlyArray<{
        readonly entry: HostNotificationEntryV22;
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
  // Read fan-out through a ref so cloud effects stay subscribed for the mode
  // lifetime. Resubscribing on every mark-read would miss arriving snapshots.
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
    (
      acknowledgementScope: FocusedNotificationScope,
      presenceEntity: HostNotificationsEntityRef,
    ): void => {
      // App-local rows run in both modes. Match against focused presence,
      // which can be narrower than a Task-level ack target.
      useAppLocalNotificationsStore
        .getState()
        .markEntityAsRead(
          acknowledgementScope.originHostId,
          presenceEntity,
          Date.now(),
        );
      if (notificationFeedMode === "cloud") {
        // The v1 entity RPC consumes ONE host's SQLite; in cloud mode the
        // rows in view can belong to any host, so consumption has to address
        // the entries themselves.
        markCloudEntityRead(acknowledgementScope);
        return;
      }
      // The v1 entity RPC consumes ONE host's SQLite - the serving host's.
      // A tile bound to another host must not acknowledge the same entity
      // there.
      if (
        acknowledgementScope.originHostId === null ||
        acknowledgementScope.originHostId === servingHostId
      ) {
        markEntityRead(acknowledgementScope.entity);
      }
    },
    [servingHostId, markEntityRead, markCloudEntityRead, notificationFeedMode],
  );
  const consumeFocusedEntity = useCallback(
    (scope: FocusedNotificationScope): void => {
      consumeEntity(scope, scope.entity);
    },
    [consumeEntity],
  );
  const onPresenceChanged = useCallback(
    (frame: HostNotificationPresenceFrame, hostId: string): void => {
      if (servingHostId !== hostId) return;
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
      if (nextEntity !== null) consumeFocusedEntity(nextEntity);
    },
    [servingHostId, consumeFocusedEntity],
  );
  const onFeedFrame = useCallback(
    (frame: HostNotificationsFeedFrame, hostId: string): void => {
      if (servingHostId !== hostId) return;
      if (frame.kind === "snapshot") {
        invalidateNotificationIndicators(queryClient, hostId, hostClient);
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
        invalidateNotificationIndicators(queryClient, hostId, hostClient);
        return;
      }
      if (frame.kind === "readStateChanged") {
        removeObservedCompletions(hostId, frame.removedIds);
        // A read-state frame can also carry retention `removedIds` for
        // unrelated rows the protocol has no entity refs for - full-invalidate
        // rather than leave those entities' indicators stale.
        if (frame.removedIds.length > 0) {
          invalidateNotificationIndicators(queryClient, hostId, hostClient);
        } else {
          invalidateNotificationIndicatorsForEntities(
            queryClient,
            hostId,
            frame.entityRefs,
            hostClient,
          );
        }
        return;
      }
      const entity = notificationEntityFromHostEntry(frame.entry);
      removeObservedCompletions(hostId, frame.removedIds);
      // Same reasoning as above: a surviving upsert's `removedIds` can name
      // entities this frame carries no ref for.
      if (frame.removedIds.length > 0) {
        invalidateNotificationIndicators(queryClient, hostId, hostClient);
      } else if (entity !== null) {
        invalidateNotificationIndicatorsForEntities(
          queryClient,
          hostId,
          [entity],
          hostClient,
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
      const activeEntity = activeEntityRef.current;
      const isTerminalSeverity =
        frame.entry.severity === "done" || frame.entry.severity === "failure";
      if (
        activeEntity === null ||
        (activeEntity.originHostId !== null &&
          activeEntity.originHostId !== hostId) ||
        !notificationEntityMatchesPresence(entity, activeEntity.entity)
      )
        return;
      if (!isTerminalSeverity) return;
      consumeEntity({ originHostId: hostId, entity }, activeEntity.entity);
    },
    [
      servingHostId,
      consumeEntity,
      recordCompletions,
      removeObservedCompletions,
      hostClient,
      queryClient,
    ],
  );
  const onHostStreamOpened = useCallback((): void => {
    activeEntityRef.current = null;
  }, []);

  const hostConnectionRef = useRef<HostConnectionLease | null>(null);

  const tearDown = useCallback((): void => {
    openedStreamClientRef.current = null;
    // Release the connection lease unconditionally. Ref-counted linger lets a
    // prompt re-open adopt it warm.
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

  // Reset relay rows and view-consumption together. An in-flight claim and
  // retry timer must not fire against the next session.
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
  const resetHostReplica = useCallback((): void => {
    activeEntityRef.current = null;
    useHostNotificationsStore.getState().reset();
    // A local activity view belongs solely to the departed host. Cloud
    // activity is a per-user union and remains valid across host switches.
    if (useAgentActivityStore.getState().servedBy === "local") {
      useAgentActivityStore.getState().reset();
    }
    resetCloudRelaySession();
    clearNotificationIndicatorCaches(queryClient);
  }, [queryClient, resetCloudRelaySession]);

  // Cloud rows are a relay snapshot. A lost binding starts a new epoch and
  // stays non-authoritative until the new snapshot.
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
    // Use the store setter. A bare setState would leave the busy gate
    // vouching with a dropped connection's union.
    noteAgentActivityConnectionStatus("reconnecting");
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
          const entity = notificationEntityFromPayload(entry.payload);
          return (
            isNewUnreadOccurrence &&
            (entry.originHostId ?? null) === activeEntity.originHostId &&
            entity !== null &&
            notificationEntityMatchesPresence(entity, activeEntity.entity)
          );
        },
      );
      if (hasUnreadArrivalForActiveEntity) {
        consumeFocusedEntity(activeEntity);
      }
    });
  }, [consumeFocusedEntity]);

  // Cloud presence: readFocusedHostNotificationPresence is the same signal as
  // host frames, one hop earlier - do not reopen a stream to learn it.
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
      if (nextEntity !== null) consumeFocusedEntity(nextEntity);
    };
    evaluate();
    return subscribeHostNotificationPresence(evaluate);
  }, [notificationFeedMode, consumeFocusedEntity]);

  // Cloud: re-evaluate consumption when the row set changes. Fan-out writes
  // nothing without targets, so this cannot mark/snapshot/mark loop.
  useEffect(() => {
    if (notificationFeedMode !== "cloud") return;
    return useCloudNotificationsStore.subscribe((state, previous) => {
      if (state.rows === previous.rows) return;
      const activeEntity = activeEntityRef.current;
      if (activeEntity === null) return;
      markCloudEntityRead(activeEntity);
    });
  }, [notificationFeedMode, markCloudEntityRead]);

  const openForCurrentUser = useCallback((): void => {
    if (
      getNotificationsStreamFactoryOverride() === null &&
      servingStreamClient === null
    ) {
      return;
    }
    // UNAUTHORIZED terminal close: re-validate against AuthnV3 to rotate
    // credentials or sign out.
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
    if (servingHostId === null) return;
    const streamHostId = servingHostId;
    // One reconnect policy per host for all four streams; each store still
    // opens its own lane so backoffs stay independent.
    const hostConnection = acquireHostConnection(streamHostId);
    hostConnectionRef.current = hostConnection;
    const reconnect = hostConnection.reconnect;
    openedStreamClientRef.current = servingStreamClient;
    const createNotificationsStream = (
      callbacks: NotificationsStreamCallbacks,
    ) => {
      const override = getNotificationsStreamFactoryOverride();
      if (override !== null) {
        return override(callbacks);
      }
      if (servingStreamClient === null) {
        throw new Error(
          "NotificationsSessionProvider: serving host stream client missing at open time.",
        );
      }
      return new NotificationsStreamClient({
        wsStreamClient: servingStreamClient,
        callbacks,
      });
    };
    // Agent activity rides the serving client, never the app-wide stream.
    // servedBy decides whether a view survives a serving-host swap.
    if (servingStreamClient !== null) {
      activityDisposerRef.current = openAgentActivityStream(
        reconnect,
        servingStreamClient,
        onAuthError,
        streamHostId,
      );
    }
    if (notificationFeedMode === "cloud") {
      if (servingStreamClient === null) return;
      // Cloud feed is host/agent only. Keep the collaboration replica live
      // or sharing notifications disappear after the mode-transition reset.
      disposerRef.current = openNotificationsStream(
        reconnect,
        createNotificationsStream,
        onAuthError,
      );
      cloudDisposerRef.current = openCloudNotificationsStream(
        reconnect,
        servingStreamClient,
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
      return;
    }
    if (notificationFeedMode === "upgrade-required") {
      useCloudNotificationsStore.getState().setConnectionState("unavailable");
      return;
    }
    // Keep replay receipts. Never treat a feed row as causal evidence over a
    // renderer-local failure.
    disposerRef.current = openNotificationsStream(
      reconnect,
      createNotificationsStream,
      onAuthError,
    );
    if (
      hostDisposerRef.current === null &&
      getNotificationsStreamFactoryOverride() === null &&
      servingStreamClient !== null
    ) {
      hostDisposerRef.current = openHostNotificationsStream(
        reconnect,
        servingStreamClient,
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
          onPresenceChanged: (frame) => onPresenceChanged(frame, streamHostId),
          onStreamOpened: onHostStreamOpened,
        },
      );
    }
  }, [
    servingStreamClient,
    authService,
    recordCompletions,
    servingHostId,
    windowId,
    showNotification,
    onFeedFrame,
    onPresenceChanged,
    onHostStreamOpened,
    notificationFeedMode,
  ]);

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
  // Key on contextMetadata.userId, not profile.email. Shared email would
  // leak the outgoing user's rows.
  useAuthIdentityTransition(status, userId, onAuthTransition);

  // Reopen on signed-in + serving-host-client transitions. Drive teardown/reopen off the client reference, not `hostId`, so a same-id endpoint respawn is followed.
  useEffect(() => {
    const isSignedIn = status === "signed-in";
    const priorStreamClient = previousStreamClientRef.current;
    previousStreamClientRef.current = servingStreamClient;

    if (!isSignedIn) {
      // `useAuthIdentityTransition`'s onTransition already tore down on the
      // signedOut path; no-op here.
      return;
    }
    // Key on the host, not the client: the test factory supplies a stream with
    // no client. Client identity still matters for respawn below.
    if (servingHostId === null) {
      tearDown();
      resetCloudRelayOwnership();
      markHostReplicaDisconnected();
      return;
    }
    // Replica goes stale on a client swap (new endpoint) or a host switch across a disconnect (A -> null -> B). A -> null -> A is a reconnect and preserves rows.
    const priorServingHostId = previousServingHostIdRef.current;
    previousServingHostIdRef.current = servingHostId;
    const clientSwapped =
      priorStreamClient !== null && priorStreamClient !== servingStreamClient;
    const hostSwitchedAcrossDisconnect =
      priorServingHostId !== null && priorServingHostId !== servingHostId;
    if (clientSwapped || hostSwitchedAcrossDisconnect) {
      tearDown();
      resetHostReplica();
    }
    if (previousFeedModeRef.current !== notificationFeedMode) {
      previousFeedModeRef.current = notificationFeedMode;
      tearDown();
      // A cloud-to-local capability change must never leave cloud rows on
      // screen. Renderer-local failure rows survive either direction because
      // no host or cloud feed can reproduce them.
      resetCloudRelaySession();
      // Entering either cloud-only state must also discard the retained v1
      // cursor and rows. Selectors are gated, but this prevents a later mode
      // transition from treating stale local pagination as current truth.
      if (notificationFeedMode !== "local") {
        useHostNotificationsStore.getState().reset();
        useNotificationsStore.getState().reset();
      }
    }
    // Same host+user, new client: rebind streams, keep the replica. Read twice
    // so the second sees tearDown() below.
    const openStreams = [
      disposerRef,
      activityDisposerRef,
      hostDisposerRef,
      cloudDisposerRef,
    ];
    if (
      anyStreamOpen(openStreams) &&
      openedStreamClientRef.current !== servingStreamClient
    ) {
      tearDown();
      resetCloudRelayOwnership();
    }
    if (!anyStreamOpen(openStreams)) {
      openForCurrentUser();
    }
  }, [
    servingHostId,
    status,
    userId,
    servingStreamClient,
    tearDown,
    resetHostReplica,
    resetCloudRelayOwnership,
    resetCloudRelaySession,
    markHostReplicaDisconnected,
    openForCurrentUser,
    notificationFeedMode,
  ]);

  useEffect(() => {
    return () => {
      tearDown();
      // tearDown only closes streams. Stop the view-consumption retry timer
      // on unmount or it outlives the provider.
      resetCloudEntityReadDriver();
    };
  }, [tearDown]);

  return (
    <NotificationConsumptionContext.Provider value={consumeFocusedEntity}>
      {props.children}
    </NotificationConsumptionContext.Provider>
  );
}

/** True when this provider still holds any of its streams open. */
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
