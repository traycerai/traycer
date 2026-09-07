import { useCallback, type ReactNode } from "react";
import { useGithubMentionFilterStore } from "@/stores/composer/github-mention-filter-store";
import { githubMentionFiltersKey } from "@/lib/persist";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useAuthIdentityTransition,
  type AuthIdentityTransition,
} from "@/hooks/auth/use-auth-identity-transition";
import {
  clearAndResetPersistedStore,
  retargetPersistedStore,
} from "@/lib/persist/zustand-persist-lifecycle";

export interface GithubMentionFiltersPersistLifecycleBridgeProps {
  readonly children: ReactNode;
}

/** Wipe GitHub host/owner/repo selection on sign-out; the next account on this profile must not read them. */
export function GithubMentionFiltersPersistLifecycleBridge(
  props: GithubMentionFiltersPersistLifecycleBridgeProps,
): ReactNode {
  const status = useAuthStore((state) => state.status);
  const userId = useAuthStore((state) => state.profile?.userId ?? null);
  // Only to name the pre-userId key for one-time adoption; NOT an identity.
  const legacyEmail = useAuthStore((state) => state.profile?.email ?? null);

  const onTransition = useCallback(
    (transition: AuthIdentityTransition) => {
      if (
        transition.kind === "signedIn" ||
        transition.kind === "userSwitched"
      ) {
        retargetPersistedStore({
          store: useGithubMentionFilterStore,
          name: githubMentionFiltersKey(transition.userId),
          // Never the anonymous bucket: a null email must not adopt shared state into an account.
          legacyName:
            legacyEmail === null ? null : githubMentionFiltersKey(legacyEmail),
        });
        return;
      }
      clearAndResetPersistedStore({
        store: useGithubMentionFilterStore,
        anonymousName: githubMentionFiltersKey(null),
      });
    },
    [legacyEmail],
  );

  useAuthIdentityTransition(status, userId, onTransition);

  return <>{props.children}</>;
}
