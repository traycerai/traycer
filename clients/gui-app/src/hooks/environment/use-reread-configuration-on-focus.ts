import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  CONFIGURATION_READS,
  invalidateConfigurationReads,
} from "@/hooks/environment/environment-host-list-key";

/**
 * Re-reads a cloud configuration when the window gains focus, alongside its
 * mounted revision observer and receipt/room readers. The window's own focus
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
