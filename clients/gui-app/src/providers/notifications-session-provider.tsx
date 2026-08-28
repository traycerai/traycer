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
import { NotificationConsumptionContext } from "@/components/notifications/notification-consumption-context";

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
 * Mounted inside the app shell post-auth. Opens the notifications stream as
 * soon as the user is signed in and tears it down on sign-out / token
 * expiry. On sign-out - and on transitions between two distinct signed-in
 * users - the local notifications replica is reset so the incoming user
 * does not see the previous user's entries.
 *
 * On a shell that has a local host, notifications always come from that
 * host (the G8 decision) - never from whichever host happens to be active in
 * a composer/tab elsewhere in the app. A shell with no local host at all
 * falls back to the bound host, because otherwise nothing would ever serve
 * it; that choice lives entirely in `useNotificationsServingHostEntry()`,
 * which is also where the reasoning for the fallback's gate lives.
 *
 * Every stream here binds to that ONE serving host through a transient,
 * non-rebinding client (`useHostStreamClientBindingFor`), never through the
 * app-wide `useWsStreamClient()`. The cloud feed rides the same client: it
 * is reached THROUGH a host, so binding it anywhere else would reintroduce
 * exactly the active-host coupling the local-host rule exists to prevent.
 */
export function NotificationsSessionProvider(
  props: NotificationsSessionProviderProps,
): ReactNode {
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
  // Unary acknowledgements share the stream's serving-host binding (the local
  // host where one exists, the bound host on a shell without one). The
  // app-wide effective host can still be unresolved when this stream opens.
  const servingHostClient = useHostClientFor(servingHostEntry);
  // A serving-host change reaches this component one commit before its
  // transport does: `useHostStreamClientBindingFor` builds the replacement
  // inside an effect, so the value rendered alongside the NEW serving entry
  // is still the OUTGOING host's binding. Opening against it would stamp the
  // new host's id onto the old host's transport - a frame arriving on the
  // outgoing host would enter the replica, toast, and persist receipts under
  // the incoming host's id.
  //
  // The proof of freshness has to be OWNERSHIP, not liveness. A released
  // client is not necessarily a closed one: a remote client's `close()`
  // drops this consumer's reference to a SHARED relay session that other
  // references - or the keep-warm linger - keep open, and the released view
  // still delegates `subscribe()` to it. So compare the binding's owner
  // identity against the identity the current serving entry demands, and
  // treat any mismatch as "no client yet". The live one arrives on the very
  // next render.
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
  // The stream client all notification streams were opened against. Stream
  // ownership follows the client instance: when the provider context serves a
  // different client (the app-wide liveness rebuild, or any same-identity
  // replacement), the old client's sessions are already dead, so the streams
  // must be torn down and reopened against the new client.
  const openedStreamClientRef =
    useRef<IHostStreamClient<HostStreamRpcRegistry> | null>(null);
  const previousStreamClientRef =
    useRef<IHostStreamClient<HostStreamRpcRegistry> | null>(
      servingStreamClient,
    );
  const previousServingHostIdRef = useRef<string | null>(servingHostId);
  // Start unset so an initially cloud-capable session also clears the legacy
  // local sources before opening its first relay stream.
  const previousFeedModeRef = useRef<
    "local" | "cloud" | "upgrade-required" | null
  >(null);
  const [fallbackWindowId] = useState(createFallbackNotificationsWindowId);
  const windowId = windowsBridge?.windowId ?? fallbackWindowId;
  const markEntityReadMutation =
    useNotificationMarkEntityRead(servingHostClient);
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
      if (notificationFeedMode === "cloud") {
        // The v1 entity RPC consumes ONE host's SQLite; in cloud mode the
        // rows in view can belong to any host, so consumption has to address
        // the entries themselves.
        markCloudEntityRead(scope);
        return;
      }
      // The v1 entity RPC consumes ONE host's SQLite - the serving host's.
      // A tile bound to another host must not acknowledge the same entity
      // there.
      if (scope.originHostId === null || scope.originHostId === servingHostId) {
        markEntityRead(scope.entity);
      }
    },
    [servingHostId, markEntityRead, markCloudEntityRead, notificationFeedMode],
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
      if (nextEntity !== null) consumeEntity(nextEntity);
    },
    [servingHostId, consumeEntity],
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
        !notificationEntitiesMatch(activeEntity.entity, entity)
      )
        return;
      if (!isTerminalSeverity) return;
      consumeEntity({ originHostId: hostId, entity });
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
    useAgentActivityStore.setState({ connectionStatus: "reconnecting" });
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

  const openForCurrentUser = useCallback((): void => {
    if (
      getNotificationsStreamFactoryOverride() === null &&
      servingStreamClient === null
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
    if (servingHostId === null) return;
    const streamHostId = servingHostId;
    // ONE reconnect policy for this host, handed to every stream opened below
    // (redesign P4.1 / connection-registry §6). This is the single wiring
    // point for all four, which is exactly why the acquisition belongs here:
    // four stores each constructing their own scheduler was the scattered
    // ownership the consolidation removes. Each store still opens its OWN
    // lane off it, so their backoffs stay independent.
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
    // Agent activity is host-selected-plane data: it rides the SAME serving
    // client as the feeds in every mode, never the app-wide active-host
    // stream. Its plane (`servedBy`) is what decides whether a view survives
    // a serving-host swap, not the host that carried it.
    if (servingStreamClient !== null) {
      activityDisposerRef.current = openAgentActivityStream(
        reconnect,
        servingStreamClient,
        onAuthError,
      );
    }
    if (notificationFeedMode === "cloud") {
      if (servingStreamClient === null) return;
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
    // Every transport session starts with a baseline snapshot. Keep durable,
    // bounded receipts for replay bookkeeping, but never treat a row from
    // this independently ordered feed as causal evidence over a renderer-local
    // failure.
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
  // Canonical `contextMetadata.userId`, not `profile.email` - two distinct
  // accounts can share an email, and an email-keyed comparison would then
  // misclassify a genuine user switch as an idle re-render, leaving the
  // outgoing user's collaboration/host rows visible to the incoming one.
  useAuthIdentityTransition(status, userId, onAuthTransition);

  // Open / reopen the stream on signed-in + serving-host-client transitions.
  // `servingStreamClient` flips to `null` when there is no serving host at
  // all (a relay-only shell before a host is bound) or the serving host's
  // channel drops - we teardown so the next reconnect lands on a fresh
  // client. It becomes a NEW object when the serving host respawns at a fresh
  // endpoint under the SAME `hostId` (`useHostStreamClientBindingFor` rebuilds the
  // transport on an endpoint move) - that reference change, not a `hostId`
  // comparison, is what drives teardown/reopen here, so a respawn is followed
  // even though the host identity never changed. On a shell WITH a local
  // host, switching the app-wide active host leaves `servingStreamClient`
  // untouched, so this effect intentionally does not re-run for that
  // transition; on a relay-only shell the bound host IS the serving host, so
  // there it re-runs and rebinds. A disconnect preserves host rows and
  // cursors - only the summary degrades to unknown until a replacement
  // snapshot lands; a genuine serving-host identity change is what resets the
  // host replica.
  useEffect(() => {
    const isSignedIn = status === "signed-in";
    const priorStreamClient = previousStreamClientRef.current;
    previousStreamClientRef.current = servingStreamClient;

    if (!isSignedIn) {
      // `useAuthIdentityTransition`'s onTransition already tore down on the
      // signedOut path; no-op here.
      return;
    }
    // Keyed on the HOST, not the client: `useHostStreamClientBindingFor` returns a
    // client exactly when it is given an entry, so in production these two are
    // the same condition - but the test stream-factory override supplies a
    // stream with no client at all, and gating on the client would make that
    // path unreachable. Client identity still matters below, for the respawn
    // case where both sides are non-null.
    if (servingHostId === null) {
      tearDown();
      resetCloudRelayOwnership();
      markHostReplicaDisconnected();
      return;
    }
    // Two independent ways the replica goes stale, and each needs its own ref
    // because neither sees the other's case:
    //
    //  - CLIENT SWAP (both sides non-null): the serving host respawned at a
    //    fresh endpoint, so it is a NEW host process with new notification
    //    state - the old rows must not survive into it.
    //  - HOST SWITCH ACROSS A DISCONNECT (A -> null -> B): the disconnect
    //    already nulled `previousStreamClientRef`, so the client comparison
    //    above sees nothing. `previousServingHostIdRef` is updated only on a
    //    non-null host, so it still spans the gap. A -> null -> A stays a
    //    reconnect (rows and cursors are preserved, the re-landed snapshot
    //    refreshes them); A -> null -> B resets before B's stream opens, or
    //    B's snapshot would land on A's stale rows for one render.
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
      // `tearDown` only closes streams. The view-consumption driver keeps its
      // own re-arming retry timer, and unmount is the one teardown edge that
      // reaches none of the `resetCloudRelaySession` call sites - so without
      // this, a failing server's retry chain outlives the provider.
      resetCloudEntityReadDriver();
    };
  }, [tearDown]);

  return (
    <NotificationConsumptionContext.Provider value={consumeEntity}>
      {props.children}
    </NotificationConsumptionContext.Provider>
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
