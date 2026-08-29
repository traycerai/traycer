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
 * Builds a `QueryClient` with the app's production configuration. Exported
 * (rather than only the singleton below) so integration tests can run against
 * the exact defaults the app runs with - the global `staleTime` in particular
 * changes `fetchQuery` semantics (it serves still-fresh cache without
 * fetching), and a test-local bare `new QueryClient()` silently exercises a
 * different behavior than production.
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
        // A `RetryableTransportError` has already been retried to exhaustion by
        // the transport layer (`createRetryingMessenger`); retrying it again here
        // multiplies the dial-timeout cost (transport attempts × query attempts).
        // Let it surface immediately; everything else keeps the single retry.
        retry: (failureCount, error) =>
          !(error instanceof RetryableTransportError) && failureCount < 1,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        // Never let `onlineManager` pause work. Its inputs (`navigator.onLine`
        // + window online/offline events) are exactly the browser signals the
        // wake-reconnect layer already documents as unreliable in the desktop
        // shell: after a sleep/wake Chromium can report offline indefinitely,
        // which under the default `networkMode: "online"` silently parked
        // every query (`fetchStatus: "paused"`) and every mutation
        // (paused-pending, so `disabled={isPending}` gates froze) until the
        // app was relaunched - the whole UI went inert while the streams
        // (wired to the OS resume pulse instead) kept flowing. Host RPCs
        // target the loopback host anyway, so "the network is down" must not
        // gate them even when true; cloud-bound calls fail fast into the
        // existing toast/error paths instead of pausing.
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
 * The app-wide catch-all for failed host RPCs, so this is the ONE log line most
 * support reports carry about a failure.
 *
 * It used to record `describeLogErrorSummary` for EVERY error, which keeps the
 * name and replaces the text with `messageLength` - a number. That reduced every
 * report to `{ name: "HostRpcError", messageLength: 198, stack: null }`, which
 * identifies nothing: two unrelated failures with equal-length messages are
 * indistinguishable, and no failure can be diagnosed at all.
 *
 * The split is by error TYPE, because the two kinds have different AUTHORS:
 *
 * - `HostRpcError` is host-authored diagnostic text and the thing support
 *   reports actually need. Logged in full, plus the structured `code` /
 *   `method` / `requestId` the message does not carry and which were dropped
 *   entirely.
 * - Everything else reaching these callbacks is app-authored and can quote the
 *   USER. `use-epic-export-artifacts-mutation` throws
 *   `"<artifact.title>" is still loading.`, and SIX hooks feeding this cache
 *   deliberately call `appLogger.errorSummary` in their own `onError`
 *   (export-artifacts, send-queued-invites, open-saved-file, mermaid-png-
 *   download, usage-image-export, git-file-diffs-batched). A global full log
 *   fires BEFORE theirs and would defeat every one of those decisions, so this
 *   branch keeps the summary.
 *
 * On the host branch specifically: `redactLogText` (inside `describeLogError`)
 * is a CREDENTIAL scrubber - it removes no filesystem path, URL, or other
 * request-derived text, so do not cite it as though it made arbitrary text
 * safe. What justifies the full message is the destination: it lands in a LOCAL
 * log file (`console.warn` -> the desktop shell's `console-message` handler ->
 * `traycer-desktop.log`) with no telemetry sink, and the support bundle that
 * log feeds already tails the HOST's own log verbatim (`diagnostics.logs.tail`),
 * which carries absolute paths by construction. A new sink for these logs
 * (telemetry, auto-upload) invalidates that, and this call site must be
 * revisited with it.
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
