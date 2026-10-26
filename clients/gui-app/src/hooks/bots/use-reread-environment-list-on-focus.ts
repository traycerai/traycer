import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { hostQueryKeys } from "@/lib/query-keys";

const ENVIRONMENT_LIST_METHOD = "environment.list";

/**
 * Re-reads the environment list when the window gains focus, for the bot
 * surfaces that list environments as sections (the channel sidebar, Home's
 * Bots band). A team is made on the dashboard, outside the app ("Create a
 * team"), and the list never polls, so a person coming back finds the new
 * team only this way. The window's own `focus` event, not TanStack's focus
 * manager, which never fires in the desktop shell (see
 * `useRetryFailedQueryOnWindowFocus`). `false` listens to nothing.
 */
export function useRereadEnvironmentListOnFocus(enabled: boolean): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled) return undefined;
    const listener = (): void => {
      void queryClient.invalidateQueries({
        predicate: (query) =>
          hostQueryKeys.matchesMethodOnAnyHost(
            query.queryKey,
            ENVIRONMENT_LIST_METHOD,
          ),
      });
    };
    window.addEventListener("focus", listener);
    return () => {
      window.removeEventListener("focus", listener);
    };
  }, [enabled, queryClient]);
}
