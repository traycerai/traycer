import { useCallback, type ReactNode } from "react";
import { useAuthStore } from "@/stores/auth/auth-store";
import { disposeAllChatSessions } from "@/lib/registries/chat-session-registry";
import { disposeAllTerminalSessions } from "@/lib/registries/terminal-session-registry";
import { disposeAllOpenEpicSessions } from "@/lib/registries/epic-session-registry";
import { clearSessionCreatedEpics } from "@/lib/epics/session-created-epics";
import {
  useAuthIdentityTransition,
  type AuthIdentityTransition,
} from "@/hooks/auth/use-auth-identity-transition";

/**
 * Renderer-side bridge that disposes every live Epic, chat, and terminal
 * session whenever the authenticated identity changes - sign-out, user-switch,
 * or a token expiry that lands the user back on the signed-out auth surface.
 *
 * The teardown is deliberately whole-registry: even resources the new identity
 * also has access to must be re-acquired so the next snapshot and chat
 * subscription land fresh. Without this, prior-user Y.Doc bytes, unsynced
 * edits, last-focused state, and live chat/terminal stream state (including a
 * warm terminal-agent session, which the terminal registry keeps lease-free
 * with no idle TTL) would leak into the next session.
 */
export interface EpicSessionLifecycleBridgeProps {
  readonly children: ReactNode;
}

export function EpicSessionLifecycleBridge(
  props: EpicSessionLifecycleBridgeProps,
): ReactNode {
  const status = useAuthStore((state) => state.status);
  const email = useAuthStore((state) => state.profile?.email ?? null);

  const onTransition = useCallback((transition: AuthIdentityTransition) => {
    if (transition.kind === "signedOut" || transition.kind === "userSwitched") {
      disposeAllOpenEpicSessions();
      disposeAllChatSessions();
      disposeAllTerminalSessions();
      // Drop the "created this session" markers so a new identity's persisted
      // tabs are reconciled normally instead of being protected by the prior
      // identity's create markers.
      clearSessionCreatedEpics();
    }
  }, []);

  useAuthIdentityTransition(status, email, onTransition);

  return <>{props.children}</>;
}
