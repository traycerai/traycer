import {
  MutationCache,
  QueryCache,
  QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  HostRpcError,
  RetryableTransportError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  appLogger,
  describeLogError,
  describeLogErrorSummary,
  type AppLogFields,
  type AppLogValue,
} from "@/lib/logger";
import { installConditionPollEpisodeCoordinator } from "@/lib/query/condition-poll-episode-coordinator";

const SAFE_QUERY_KEY_MARKERS = new Set([
  "auth",
  "host",
  "git",
  "capabilities",
  "listChangedFiles",
  "fileDiff",
]);

/**
 * Builds a `QueryClient` with the app's production configuration.
 * Exported (rather than only the singleton below) so integration tests can run against the exact defaults the app runs with - the global `staleTime` in particular changes `fetchQuery` semantics (it serves still-fresh cache without fetching), and a test-local.
 */
export function createAppQueryClient(): QueryClient {
  const client = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        appLogger.warn("[query] request failed", {
          queryKey: summarizeQueryKey(query.queryKey),
          failureCount: query.state.fetchFailureCount,
          fetchStatus: query.state.fetchStatus,
          status: query.state.status,
          error: describeRequestError(error),
        });
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        appLogger.warn("[mutation] request failed", {
          mutationKey: summarizeQueryKey(mutation.options.mutationKey ?? []),
          failureCount: mutation.state.failureCount,
          status: mutation.state.status,
          error: describeRequestError(error),
        });
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 60 * 1000,
        // A `RetryableTransportError` has already been retried to exhaustion by the transport layer (`createRetryingMessenger`); retrying it again here multiplies the dial-timeout cost (transport attempts × query attempts).
        retry: (failureCount, error) =>
          !(error instanceof RetryableTransportError) && failureCount < 1,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        // Never let `onlineManager` pause work.
        // Its inputs (`navigator.onLine` + window online/offline events) are exactly the browser signals the wake-reconnect layer already documents as unreliable in the desktop shell: after a sleep/wake Chromium can report offline indefinitely, which under the.
        networkMode: "always",
      },
      mutations: {
        // Same reasoning as the query default above: a paused mutation is a
        // dead button.
        networkMode: "always",
      },
    },
  });
  installConditionPollEpisodeCoordinator(client);
  return client;
}

export const queryClient = createAppQueryClient();

/**
 * App-wide failed-host-RPC log: `HostRpcError` in full (local log file, no telemetry); everything else stays summarized because it can quote the user.
 * `redactLogText` is a credential scrubber only - it does not strip paths.
 */
function describeRequestError(error: unknown): AppLogFields {
  if (!(error instanceof HostRpcError)) {
    return describeLogErrorSummary(error);
  }
  // Structured attribution the message text does not carry, and which was
  // previously dropped entirely.
  return {
    ...describeLogError(error),
    code: error.code,
    method: error.method,
    requestId: error.requestId,
  };
}

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
