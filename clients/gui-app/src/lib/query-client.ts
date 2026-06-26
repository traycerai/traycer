import {
  MutationCache,
  QueryCache,
  QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { RetryableTransportError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  appLogger,
  describeLogErrorSummary,
  type AppLogValue,
} from "@/lib/logger";

const SAFE_QUERY_KEY_MARKERS = new Set([
  "auth",
  "host",
  "git",
  "capabilities",
  "listChangedFiles",
  "fileDiff",
]);

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      appLogger.warn("[query] request failed", {
        queryKey: summarizeQueryKey(query.queryKey),
        failureCount: query.state.fetchFailureCount,
        fetchStatus: query.state.fetchStatus,
        status: query.state.status,
        error: describeLogErrorSummary(error),
      });
    },
  }),
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      appLogger.warn("[mutation] request failed", {
        mutationKey: summarizeQueryKey(mutation.options.mutationKey ?? []),
        failureCount: mutation.state.failureCount,
        status: mutation.state.status,
        error: describeLogErrorSummary(error),
      });
    },
  }),
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

function summarizeQueryKey(queryKey: QueryKey): AppLogValue {
  return queryKey.slice(0, 4).map((part) => {
    if (typeof part === "string") {
      return safeQueryKeyString(part);
    }
    if (Array.isArray(part)) {
      return "array";
    }
    if (part !== null && typeof part === "object") {
      return "object";
    }
    return typeof part;
  });
}

function safeQueryKeyString(value: string): string {
  if (SAFE_QUERY_KEY_MARKERS.has(value)) {
    return value;
  }
  if (value.startsWith("runner.")) {
    return value;
  }
  if (value.includes("/") || value.includes("\\") || value.length > 80) {
    return "string";
  }
  return value.includes(".") && /^[a-zA-Z0-9_.:-]+$/.test(value)
    ? value
    : "string";
}
