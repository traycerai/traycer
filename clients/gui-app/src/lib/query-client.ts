import { QueryClient } from "@tanstack/react-query";
import { RetryableTransportError } from "@traycer-clients/shared/host-transport/host-messenger";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60 * 1000,
      // A `RetryableTransportError` has already been retried to exhaustion by
      // the transport layer (`createRetryingMessenger`); retrying it again here
      // multiplies the dial-timeout cost (transport attempts × query attempts).
      // Let it surface immediately; everything else keeps the single retry.
      retry: (failureCount, error) =>
        !(error instanceof RetryableTransportError) && failureCount < 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
});
