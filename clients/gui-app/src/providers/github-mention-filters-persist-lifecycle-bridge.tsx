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

/**
 * Binds the mention-filter store's persistence to the signed-in identity,
 * exactly like the composer run-settings bridge above it in the tree. The
 * store's rows are not account-neutral view state: a repository selection
 * names a GitHub host, owner and repo, and for a private repository those
 * coordinates are themselves private - so sign-out WIPES the bucket rather
 * than leaving it readable to the next account on this profile.
 */
export function GithubMentionFiltersPersistLifecycleBridge(
  props: GithubMentionFiltersPersistLifecycleBridgeProps,
): ReactNode {
  const status = useAuthStore((state) => state.status);
  const email = useAuthStore((state) => state.profile?.email ?? null);

  const onTransition = useCallback((transition: AuthIdentityTransition) => {
    if (transition.kind === "signedIn" || transition.kind === "userSwitched") {
      retargetPersistedStore({
        store: useGithubMentionFilterStore,
        name: githubMentionFiltersKey(transition.email),
      });
      return;
    }
    clearAndResetPersistedStore({
      store: useGithubMentionFilterStore,
      anonymousName: githubMentionFiltersKey(null),
    });
  }, []);

  useAuthIdentityTransition(status, email, onTransition);

  return <>{props.children}</>;
}
