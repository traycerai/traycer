import { useCallback, type ReactNode } from "react";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useAuthIdentityTransition,
  type AuthIdentityTransition,
} from "@/hooks/auth/use-auth-identity-transition";
import {
  activateReadingPositionAccount,
  deactivateReadingPositionAccount,
} from "@/lib/reading-position";

export function ReadingPositionPersistLifecycleBridge(props: {
  readonly children: ReactNode;
}): ReactNode {
  const status = useAuthStore((state) => state.status);
  const userId = useAuthStore(
    (state) => state.contextMetadata?.userId ?? state.profile?.userId ?? null,
  );
  const onTransition = useCallback((transition: AuthIdentityTransition) => {
    if (transition.kind === "signedIn" || transition.kind === "userSwitched") {
      if (transition.userId !== null) {
        activateReadingPositionAccount(transition.userId);
      }
      return;
    }
    // Reading position can expose which private content was being read. A
    // full sign-out removes the signed-in bucket from this computer.
    deactivateReadingPositionAccount(true);
  }, []);

  useAuthIdentityTransition(status, userId, onTransition);
  return <>{props.children}</>;
}
