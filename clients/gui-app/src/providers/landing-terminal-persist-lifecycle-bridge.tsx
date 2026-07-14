import { useCallback, type ReactNode } from "react";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useAuthIdentityTransition,
  type AuthIdentityTransition,
} from "@/hooks/auth/use-auth-identity-transition";
import { landingTerminalsKey } from "@/lib/persist";
import { useHostClient, useHostDirectory } from "@/lib/host";
import { buildTransientHostClient } from "@/hooks/host/use-host-client-for";
import {
  clearAndResetPersistedStore,
  retargetPersistedStore,
} from "@/lib/persist/zustand-persist-lifecycle";
import { useLandingTerminalStore } from "@/stores/home/landing-terminal-store";

export interface LandingTerminalPersistLifecycleBridgeProps {
  readonly children: ReactNode;
}

/**
 * Retargets landing-terminal references with auth identity. Independent PTYs
 * are owned by one user, so a global/local anonymous bucket would otherwise
 * let a later sign-in adopt another user's sessions.
 */
export function LandingTerminalPersistLifecycleBridge(
  props: LandingTerminalPersistLifecycleBridgeProps,
): ReactNode {
  const status = useAuthStore((state) => state.status);
  const email = useAuthStore((state) => state.profile?.email ?? null);
  const defaultClient = useHostClient();
  const directory = useHostDirectory();
  const drainTombstones = useCallback(() => {
    for (const pending of useLandingTerminalStore.getState().pendingKills) {
      const entry = directory.findById(pending.hostId);
      const client =
        entry === null ? null : buildTransientHostClient(defaultClient, entry);
      if (client === null) continue;
      // Sign-out is a teardown boundary, not a UI request surface: retain no
      // promise and clear the identity bucket immediately afterwards. An
      // unreachable host keeps the documented residual exception.
      void client
        .request("terminal.kill", { sessionId: pending.sessionId })
        .then(
          () => undefined,
          () => undefined,
        );
    }
  }, [defaultClient, directory]);
  const onTransition = useCallback(
    (transition: AuthIdentityTransition) => {
      if (
        transition.kind === "signedIn" ||
        transition.kind === "userSwitched"
      ) {
        retargetPersistedStore({
          store: useLandingTerminalStore,
          name: landingTerminalsKey(transition.email),
        });
        return;
      }
      drainTombstones();
      clearAndResetPersistedStore({
        store: useLandingTerminalStore,
        anonymousName: landingTerminalsKey(null),
      });
    },
    [drainTombstones],
  );

  useAuthIdentityTransition(status, email, onTransition);

  return <>{props.children}</>;
}
