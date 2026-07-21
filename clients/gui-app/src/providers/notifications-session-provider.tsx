import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { NotificationsStreamClient } from "@traycer-clients/shared/host-transport/notifications-stream-client";
import type { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { useWsStreamClient } from "@/lib/host/stream-runtime-context";
import {
  openNotificationsStream,
  useNotificationsStore,
} from "@/stores/notifications/notifications-store";
import {
  openHostNotificationsStream,
  type HostNotificationsFeedFrame,
  useHostNotificationsStore,
} from "@/stores/notifications/host-notifications-store";
import type { HostNotificationPresenceFrame } from "@/lib/notifications/notification-presence";
import { getNotificationsStreamFactoryOverride } from "@/providers/notifications-stream-factory-override";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useAuthService } from "@/lib/host";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useNotificationShow } from "@/hooks/notifications/use-notifications";
import { useNotificationActivation } from "@/hooks/notifications/use-notification-activation";
import { useNotificationMarkEntityRead } from "@/hooks/notifications/use-notification-mark-entity-read-mutation";
import { useWindowsBridge } from "@/providers/windows-bridge-context";
import {
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
} from "@/lib/notifications";
import { useAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";
import type { HostNotificationsEntityRef } from "@traycer/protocol/host/notifications/contracts";
import {
  useMergedNotificationsActions,
  type MergedNotificationRow,
} from "@/stores/notifications/merged-notifications";
import { activationResultHandler } from "@/lib/notifications/notification-activation-result";

export interface NotificationsSessionProviderProps {
  readonly children: ReactNode;
}

/**
 * Mounted inside the app shell post-auth. Opens the notifications stream as
 * soon as the user is signed in and tears it down on sign-out / token
 * expiry. On sign-out - and on transitions between two distinct signed-in
 * users - the local notifications replica is reset so the incoming user
 * does not see the previous user's entries.
 */
export function NotificationsSessionProvider(
  props: NotificationsSessionProviderProps,
): ReactNode {
  const wsStreamClient = useWsStreamClient();
  const queryClient = useQueryClient();
  const activeHostId = useReactiveActiveHostId();
  const authService = useAuthService();
  const showNotification = useNotificationShow();
  const { activate } = useNotificationActivation();
  const mergedActions = useMergedNotificationsActions();
  const windowsBridge = useWindowsBridge();
  const status = useAuthStore((state) => state.status);
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const disposerRef = useRef<(() => void) | null>(null);
  const hostDisposerRef = useRef<(() => void) | null>(null);
  // The stream client BOTH notification streams were opened against. Stream
  // ownership follows the client instance: when the provider context serves a
  // different client (the app-wide liveness rebuild, or any same-identity
  // replacement), the old client's sessions are already dead, so the streams
  // must be torn down and reopened against the new client.
  const openedStreamClientRef =
    useRef<WsStreamClient<HostStreamRpcRegistry> | null>(null);
  const previousHostIdRef = useRef<string | null>(activeHostId);
  const [fallbackWindowId] = useState(createFallbackNotificationsWindowId);
  const windowId = windowsBridge?.windowId ?? fallbackWindowId;
  const markEntityReadMutation = useNotificationMarkEntityRead();
  const markEntityRead = markEntityReadMutation.mutate;
  const activeEntityRef = useRef<HostNotificationsEntityRef | null>(null);
  const onToastClick = useCallback(
    (row: MergedNotificationRow): void => {
      if (row.payload === null) return;
      activate({
        payload: row.payload,
        receivedAt: row.createdAt,
        feedId: row.feedId,
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
  const consumeEntity = useCallback(
    (entity: HostNotificationsEntityRef): void => {
      useAppLocalNotificationsStore
        .getState()
        .markEntityAsRead(entity, Date.now());
      markEntityRead(entity);
    },
    [markEntityRead],
  );
  const onPresenceChanged = useCallback(
    (frame: HostNotificationPresenceFrame, hostId: string): void => {
      if (activeHostId !== hostId) return;
      const nextEntity = entityFromFocusedPresence(frame);
      const previousEntity = activeEntityRef.current;
      if (
        (nextEntity === null && previousEntity === null) ||
        (nextEntity !== null &&
          previousEntity !== null &&
          notificationEntitiesMatch(nextEntity, previousEntity))
      )
        return;
      activeEntityRef.current = nextEntity;
      if (nextEntity !== null) consumeEntity(nextEntity);
    },
    [activeHostId, consumeEntity],
  );
  const onFeedFrame = useCallback(
    (frame: HostNotificationsFeedFrame, hostId: string): void => {
      if (activeHostId !== hostId) return;
      if (
        frame.kind === "snapshot" ||
        frame.kind === "cleared" ||
        frame.kind === "removed"
      ) {
        invalidateNotificationIndicators(queryClient, hostId);
        return;
      }
      if (frame.kind === "readStateChanged") {
        // A read-state frame can also carry retention `removedIds` for
        // unrelated rows the protocol has no entity refs for - full-invalidate
        // rather than leave those entities' indicators stale.
        if (frame.removedIds.length > 0) {
          invalidateNotificationIndicators(queryClient, hostId);
        } else {
          invalidateNotificationIndicatorsForEntities(
            queryClient,
            hostId,
            frame.entityRefs,
          );
        }
        return;
      }
      const entity = notificationEntityFromHostEntry(frame.entry);
      // Same reasoning as above: a surviving upsert's `removedIds` can name
      // entities this frame carries no ref for.
      if (frame.removedIds.length > 0) {
        invalidateNotificationIndicators(queryClient, hostId);
      } else if (entity !== null) {
        invalidateNotificationIndicatorsForEntities(queryClient, hostId, [
          entity,
        ]);
      }
      if (entity === null) return;
      const activeEntity = activeEntityRef.current;
      const isTerminalSeverity =
        frame.entry.severity === "done" || frame.entry.severity === "failure";
      if (
        activeEntity === null ||
        !notificationEntitiesMatch(activeEntity, entity)
      )
        return;
      if (!isTerminalSeverity) return;
      consumeEntity(entity);
    },
    [activeHostId, consumeEntity, queryClient],
  );
  const onHostStreamOpened = useCallback((): void => {
    activeEntityRef.current = null;
  }, []);

  const tearDown = useCallback((): void => {
    openedStreamClientRef.current = null;
    if (disposerRef.current !== null) {
      const disposer = disposerRef.current;
      disposerRef.current = null;
      disposer();
    }
    if (hostDisposerRef.current !== null) {
      const disposer = hostDisposerRef.current;
      hostDisposerRef.current = null;
      disposer();
    }
  }, []);

  // Identity/sign-out owns the full reset: every user-owned replica (host,
  // collaboration) is cleared so the incoming user never sees the prior
  // user's entries.
  const resetIdentityReplica = useCallback((): void => {
    activeEntityRef.current = null;
    useNotificationsStore.getState().reset();
    useHostNotificationsStore.getState().reset();
    clearNotificationIndicatorCaches(queryClient);
  }, [queryClient]);

  // A host switch only invalidates host-owned truth. Collaboration/system
  // rows are not scoped to a host and must survive the swap untouched.
  const resetHostReplica = useCallback((): void => {
    activeEntityRef.current = null;
    useHostNotificationsStore.getState().reset();
    clearNotificationIndicatorCaches(queryClient);
  }, [queryClient]);

  // A disconnect (IPC drop / host restart) is not a truth reset: rendered
  // host rows and cursors stay put, and only the exact summary degrades to
  // unknown until a fresh atomic snapshot lands on reconnect.
  const markHostReplicaDisconnected = useCallback((): void => {
    activeEntityRef.current = null;
    useHostNotificationsStore.getState().setConnectionStatus("connecting");
  }, []);

  // StrictMode mounts, cleans up, then re-mounts effects. Returning Zustand's
  // unsubscribe means exactly one live app-local listener survives that cycle;
  // it always reads the current ref and callback rather than a stale snapshot.
  useEffect(() => {
    return useAppLocalNotificationsStore.subscribe((state, previous) => {
      const activeEntity = activeEntityRef.current;
      if (activeEntity === null) return;
      const hasUnreadArrivalForActiveEntity = Object.values(state.byId).some(
        (entry) =>
          entry.readAt === null &&
          !Object.hasOwn(previous.byId, entry.id) &&
          notificationPayloadBelongsToEntity(entry.payload, activeEntity),
      );
      if (hasUnreadArrivalForActiveEntity) {
        consumeEntity(activeEntity);
      }
    });
  }, [consumeEntity]);

  const openForCurrentUser = useCallback((): void => {
    if (
      getNotificationsStreamFactoryOverride() === null &&
      wsStreamClient === null
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
    if (activeHostId === null) return;
    const streamHostId = activeHostId;
    openedStreamClientRef.current = wsStreamClient;
    disposerRef.current = openNotificationsStream((callbacks) => {
      const override = getNotificationsStreamFactoryOverride();
      if (override !== null) {
        return override(callbacks);
      }
      if (wsStreamClient === null) {
        throw new Error(
          "NotificationsSessionProvider: WsStreamClient missing at open time.",
        );
      }
      return new NotificationsStreamClient({
        wsStreamClient,
        callbacks,
      });
    }, onAuthError);
    if (
      hostDisposerRef.current === null &&
      getNotificationsStreamFactoryOverride() === null &&
      wsStreamClient !== null
    ) {
      hostDisposerRef.current = openHostNotificationsStream(
        wsStreamClient,
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
    wsStreamClient,
    authService,
    activeHostId,
    windowId,
    showNotification,
    onFeedFrame,
    onPresenceChanged,
    onHostStreamOpened,
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

  // Open / reopen the stream on signed-in + active-host transitions.
  // `activeHostId` flips to `null` when the desktop host restarts or the
  // IPC channel drops - we teardown so the next reconnect lands on a fresh
  // client, but this is a disconnect, not an identity/host change: host rows
  // and cursors are preserved and only the summary degrades to unknown until
  // a replacement snapshot lands. A genuine host switch resets only the host
  // replica so the re-landed snapshot isn't merged into a stale local doc.
  useEffect(() => {
    const isSignedIn = status === "signed-in";

    if (!isSignedIn) {
      // `useAuthIdentityTransition`'s onTransition already tore down on the
      // signedOut path; no-op here.
      return;
    }
    if (activeHostId === null) {
      tearDown();
      markHostReplicaDisconnected();
      return;
    }
    // Only updated on a non-null host so it survives an intervening
    // disconnect: A -> null -> A must not look like a switch (the reconnect
    // snapshot alone refreshes the preserved rows), but A -> null -> B must
    // still reset the host replica before B's stream opens, or B's snapshot
    // would land on top of A's stale rows for one render.
    const priorHostId = previousHostIdRef.current;
    previousHostIdRef.current = activeHostId;
    if (priorHostId !== null && priorHostId !== activeHostId) {
      tearDown();
      resetHostReplica();
    }
    // A replaced stream client under the SAME host + user (the app-wide
    // liveness rebuild after the client was closed underneath the provider)
    // closes the old client's sessions, so both notification streams must
    // rebind to the new client. The identity did not change, so the replica
    // is kept - the re-landed snapshot merges into the same doc.
    if (
      disposerRef.current !== null &&
      openedStreamClientRef.current !== wsStreamClient
    ) {
      tearDown();
    }
    if (disposerRef.current === null) {
      openForCurrentUser();
    }
  }, [
    activeHostId,
    status,
    userId,
    wsStreamClient,
    tearDown,
    resetHostReplica,
    markHostReplicaDisconnected,
    openForCurrentUser,
  ]);

  useEffect(() => {
    return () => {
      tearDown();
    };
  }, [tearDown]);

  return <>{props.children}</>;
}

function entityFromFocusedPresence(
  frame: HostNotificationPresenceFrame,
): HostNotificationsEntityRef | null {
  if (
    !frame.focused ||
    frame.entity === null ||
    frame.entity.epicId === undefined
  ) {
    return null;
  }
  return frame.entity.chatId === undefined
    ? { epicId: frame.entity.epicId }
    : { epicId: frame.entity.epicId, chatId: frame.entity.chatId };
}

function createFallbackNotificationsWindowId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi.randomUUID === "function") {
    return `browser:${cryptoApi.randomUUID()}`;
  }
  return `browser:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
