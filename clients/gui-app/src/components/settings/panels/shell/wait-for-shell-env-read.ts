import {
  CancelledError,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";

/** Wait for fresh rows, following cancellations to the replacement read. */
export async function waitForShellEnvRead(
  queryClient: QueryClient,
  queryKey: QueryKey,
): Promise<void> {
  for (;;) {
    try {
      await queryClient.refetchQueries(
        { queryKey },
        { cancelRefetch: false, throwOnError: true },
      );
      return;
    } catch (error) {
      // Focus or another invalidation can replace the fetch we joined. Join
      // its replacement instead of reporting the successful write as failed.
      if (!(error instanceof CancelledError)) throw error;
    }
  }
}
