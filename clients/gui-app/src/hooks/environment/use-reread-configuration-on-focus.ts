import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  CONFIGURATION_READS,
  invalidateConfigurationReads,
} from "@/hooks/environment/environment-host-list-key";

/**
 * Re-reads a cloud configuration's reads when the window gains focus. A team,
 * or Personal on a window whose host does not run it, has no host status
 * reporting its new revision, and its reads never poll: a change made by
 * another person, another computer or the dashboard reaches an open page
 * only this way. The window's own `focus`
 * event, not TanStack's focus manager, which never fires in the desktop shell
 * (see `useRetryFailedQueryOnWindowFocus`). `null` listens to nothing.
 */
export function useRereadConfigurationOnFocus(
  environmentId: string | null,
): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (environmentId === null) return undefined;
    const listener = (): void => {
      invalidateConfigurationReads(
        queryClient,
        environmentId,
        CONFIGURATION_READS,
      );
    };
    window.addEventListener("focus", listener);
    return () => {
      window.removeEventListener("focus", listener);
    };
  }, [environmentId, queryClient]);
}
