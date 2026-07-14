import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { NotificationsStreamClient } from "@traycer-clients/shared/host-transport/notifications-stream-client";
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
  const windowsBridge = useWindowsBridge();
  const status = useAuthStore((state) => state.status);
  const email = useAuthStore((state) => state.profile?.email ?? null);
  const disposerRef = useRef<(() => void) | null>(null);
  const hostDisposerRef = useRef<(() => void) | null>(null);
  const previousHostIdRef = useRef<string | null>(activeHostId);
  const [fallbackWindowId] = useState(createFallbackNotificationsWindowId);
  const windowId = windowsBridge?.windowId ?? fallbackWindowId;
  const markEntityReadMutation = useNotificationMarkEntityRead();
  const markEntityRead = markEntityReadMutation.mutate;
  const activeEntityRef = useRef<HostNotificationsEntityRef | null>(null);
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
      if (frame.kind === "snapshot" || frame.kind === "cleared") {
        invalidateNotificationIndicators(queryClient, hostId);
        return;
      }
      if (frame.kind === "readStateChanged") {
        invalidateNotificationIndicatorsForEntities(
          queryClient,
          hostId,
          frame.entityRefs,
        );
        return;
      }
      const entity = notificationEntityFromHostEntry(frame.entry);
      if (entity === null) return;
      invalidateNotificationIndicatorsForEntities(queryClient, hostId, [
        entity,
      ]);
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

  const resetReplica = useCallback((): void => {
    activeEntityRef.current = null;
    useNotificationsStore.getState().reset();
    useHostNotificationsStore.getState().reset();
    clearNotificationIndicatorCaches(queryClient);
  }, [queryClient]);

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
            displayHostChannelEmission(entries, {
              showNotification,
              playChime: playNotificationChime,
            });
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
        resetReplica();
      }
    },
    [tearDown, resetReplica],
  );
  useAuthIdentityTransition(status, email, onAuthTransition);

  // Open / reopen the stream on signed-in + active-host transitions.
  // `activeHostId` flips to `null` when the desktop host restarts or the
  // IPC channel drops - we teardown so the next reconnect lands on a fresh
  // client, and reset the replica so the re-landed snapshot isn't merged
  // into a stale local doc.
  useEffect(() => {
    const isSignedIn = status === "signed-in";
    const priorHostId = previousHostIdRef.current;
    previousHostIdRef.current = activeHostId;

    if (!isSignedIn) {
      // `useAuthIdentityTransition`'s onTransition already tore down on the
      // signedOut path; no-op here.
      return;
    }
    if (activeHostId === null) {
      tearDown();
      resetReplica();
      return;
    }
    if (priorHostId !== null && priorHostId !== activeHostId) {
      tearDown();
      resetReplica();
    }
    if (disposerRef.current === null) {
      openForCurrentUser();
    }
  }, [
    activeHostId,
    status,
    email,
    wsStreamClient,
    tearDown,
    resetReplica,
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
