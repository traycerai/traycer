import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { NotificationsStreamClient } from "@traycer-clients/shared/host-transport/notifications-stream-client";
import { useWsStreamClient } from "@/lib/host/stream-runtime-context";
import {
  openNotificationsStream,
  useNotificationsStore,
} from "@/stores/notifications/notifications-store";
import { getNotificationsStreamFactoryOverride } from "@/providers/notifications-stream-factory-override";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useAuthService } from "@/lib/host";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import {
  useAuthIdentityTransition,
  type AuthIdentityTransition,
} from "@/hooks/auth/use-auth-identity-transition";

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
  const activeHostId = useReactiveActiveHostId();
  const authService = useAuthService();
  const status = useAuthStore((state) => state.status);
  const email = useAuthStore((state) => state.profile?.email ?? null);
  const disposerRef = useRef<(() => void) | null>(null);
  const previousHostIdRef = useRef<string | null>(activeHostId);

  const tearDown = useCallback((): void => {
    if (disposerRef.current === null) {
      return;
    }
    const disposer = disposerRef.current;
    disposerRef.current = null;
    disposer();
  }, []);

  const resetReplica = useCallback((): void => {
    useNotificationsStore.getState().reset();
  }, []);

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
  }, [wsStreamClient, authService]);

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
