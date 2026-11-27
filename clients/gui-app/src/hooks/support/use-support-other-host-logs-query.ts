import { useMemo } from "react";
import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import { isRemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  MAX_REPORT_OTHER_HOST_LOGS,
  REPORT_OTHER_HOST_LOG_MAX_RAW_CHARS,
  REPORT_OTHER_HOST_LOG_TAIL_LINES,
  REPORT_OTHER_HOST_VERSION_MAX_CHARS,
} from "@traycer-clients/shared/support/image-attachment-guards";
import { useConnectableHostIds } from "@/hooks/host/use-connectable-host-ids";
import { useHostDiscoveryConcluded } from "@/hooks/host/use-host-discovery-concluded";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useDeadlineReached } from "@/hooks/use-deadline-reached";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import { computerNameFromLabel } from "@/lib/host/host-name";
import { runnerQueryKeys, supportBridgeQueryScopeId } from "@/lib/query-keys";
import type { DesktopSupportBridge } from "@/lib/windows/types";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";

/**
 * How long one computer gets to answer. A computer that is reachable answers
 * well inside this; one that is not must not hold the report.
 */
export const REPORT_OTHER_HOST_LOG_READ_TIMEOUT_MS = 5_000;

/**
 * The longest a report is held for these tails, counted from when it was
 * prepared. Past it the report can be sent, and carries only tails already
 * frozen by then.
 */
export const REPORT_OTHER_HOST_LOGS_HOLD_MS = 10_000;

/** Another computer this app can reach right now. */
interface ReportOtherComputer {
  readonly hostId: string;
  readonly name: string;
  readonly version: string | null;
}

/** One other computer's frozen host log tail, as the report ships it. */
export interface SupportOtherHostLog {
  readonly hostId: string;
  readonly name: string;
  /** Null when the computer did not answer the read. */
  readonly lines: readonly string[] | null;
}

/**
 * The other computers a report reads: every remote one this app can dial right
 * now, the chat's own first so the cap can never be what leaves it out.
 *
 * `chatHostId` is the computer the reported chat runs on, when there is one.
 */
function useReportOtherComputers(
  chatHostId: string | null,
): readonly ReportOtherComputer[] {
  const directory = useHostDirectoryList();
  const connectable = useConnectableHostIds();
  return useMemo(() => {
    const reachable = (directory.data ?? []).filter(
      (entry) =>
        isRemoteHostDirectoryEntry(entry) &&
        connectable.hostIds.includes(entry.hostId),
    );
    return [
      ...reachable.filter((entry) => entry.hostId === chatHostId),
      ...reachable.filter((entry) => entry.hostId !== chatHostId),
    ]
      .slice(0, MAX_REPORT_OTHER_HOST_LOGS)
      .map((entry) => ({
        hostId: entry.hostId,
        name: computerNameFromLabel(entry.label, entry.hostId),
        // A registry row may carry any string here; one too long to send is
        // left out, so it cannot have every computer's tail refused.
        version:
          entry.version !== null &&
          entry.version.length > REPORT_OTHER_HOST_VERSION_MAX_CHARS
            ? null
            : entry.version,
      }));
  }, [chatHostId, connectable.hostIds, directory.data]);
}

/**
 * The trailing lines of a tail that fit what Electron main accepts. A host
 * answers within both bounds already; this holds one that does not to them,
 * so a single odd answer cannot have the whole freeze refused.
 */
function trailingLinesWithinBounds(answer: readonly string[]): string[] {
  // One entry per physical line, which is what both bounds count.
  const lines = answer.flatMap((entry) => entry.split(/\r\n|\r|\n/));
  const kept: string[] = [];
  let characters = 0;
  for (const line of lines.toReversed()) {
    characters += line.length;
    if (
      kept.length === REPORT_OTHER_HOST_LOG_TAIL_LINES ||
      characters > REPORT_OTHER_HOST_LOG_MAX_RAW_CHARS
    ) {
      break;
    }
    kept.push(line);
  }
  return kept.toReversed();
}

async function readHostLogTail(
  binding: HostRuntimeBinding<HostRpcRegistry> | null,
  hostId: string,
  signal: AbortSignal,
): Promise<readonly string[] | null> {
  const client = resolveNamedHostClient(binding, hostId);
  if (client === null) return null;
  // Aborted by the query being torn down or by the deadline, whichever comes
  // first; the transport rejects a request whose signal aborts.
  const read = new AbortController();
  const abortRead = (): void => {
    read.abort();
  };
  signal.addEventListener("abort", abortRead);
  const deadline = setTimeout(abortRead, REPORT_OTHER_HOST_LOG_READ_TIMEOUT_MS);
  try {
    const tail = await client.requestWithSignal(
      "diagnostics.logs.tail",
      { target: "host", tailLines: REPORT_OTHER_HOST_LOG_TAIL_LINES },
      read.signal,
    );
    return tail.status === "available"
      ? trailingLinesWithinBounds(tail.lines)
      : null;
  } catch (error) {
    // A cancelled read is the query being torn down, not a computer that did
    // not answer: it must not freeze as one.
    if (signal.aborted) throw error;
    return null;
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", abortRead);
  }
}

/**
 * Reads the host log tail of each of `computers` and freezes them onto one
 * report. Keyed by the report and never stale, so it runs once per report:
 * the computers and tails are the ones read when the report was prepared,
 * like the local tails beside them, whatever the directory does afterwards.
 *
 * A bare query, not `useHostQueries`: that hook reads one computer and caches
 * under its host key, and this reads several into one result that belongs to
 * the report and must not be served from, or served to, the Settings tail.
 */
function supportOtherHostLogsQueryOptions(args: {
  readonly support: DesktopSupportBridge | null;
  readonly binding: HostRuntimeBinding<HostRpcRegistry> | null;
  readonly draftId: number;
  readonly reportId: string | null;
  readonly computers: readonly ReportOtherComputer[];
}) {
  const { support, binding, draftId, reportId, computers } = args;
  // `binding` only resolves clients, and `computers` is deliberately outside
  // the key: a computer appearing or leaving must not re-read a frozen report.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  return queryOptions({
    queryKey: runnerQueryKeys.supportOtherHostLogs(
      supportBridgeQueryScopeId(support),
      draftId,
      reportId,
    ),
    queryFn: async ({ signal }): Promise<readonly SupportOtherHostLog[]> => {
      if (support === null || reportId === null) {
        throw new Error("Support bridge unavailable");
      }
      const logs = await Promise.all(
        computers.map(async (computer) => ({
          hostId: computer.hostId,
          version: computer.version,
          lines: await readHostLogTail(binding, computer.hostId, signal),
        })),
      );
      const frozen = await support.freezeOtherHostLogs({
        draftId,
        reportId,
        logs,
      });
      const frozenLinesByHostId = new Map(
        frozen.logs.map((log) => [log.hostId, log.lines]),
      );
      return computers.map((computer) => ({
        hostId: computer.hostId,
        name: computer.name,
        lines: frozenLinesByHostId.get(computer.hostId) ?? null,
      }));
    },
    enabled: support !== null && reportId !== null && computers.length > 0,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export interface SupportOtherHostLogs {
  /**
   * Null while there is no other computer to read, which is when the consent
   * panel shows no row for them. It stays non-null for as long as tails are
   * frozen on this report, even if that computer has since left.
   */
  readonly query: UseQueryResult<readonly SupportOtherHostLog[]> | null;
  /**
   * True once the tails are frozen onto the report. A report includes them
   * only then, so one sent after the hold ran out cannot pick up tails that
   * land later.
   */
  readonly frozen: boolean;
  /**
   * True while a report set to include these tails is held: it is not yet
   * known which computers there are, or a tail is still being read. Nothing is
   * sent meanwhile, so what ships does not depend on how quickly the person
   * pressed the button, and the row was on screen before anything rode along.
   * False once {@link REPORT_OTHER_HOST_LOGS_HOLD_MS} has passed, whatever is
   * still outstanding, and false for a report that could not be prepared.
   */
  readonly pending: boolean;
}

/**
 * The other connected computers' host log tails for one report draft.
 * `reportId` is null until the draft's local evidence is frozen, and
 * `preparedAtMs` is when that freeze was asked for.
 */
export function useSupportOtherHostLogsQuery(args: {
  readonly support: DesktopSupportBridge | null;
  readonly draftId: number;
  readonly reportId: string | null;
  readonly preparedAtMs: number;
  readonly chatHostId: string | null;
  /** Whether the report is set to include these tails. */
  readonly included: boolean;
}): SupportOtherHostLogs {
  const binding = useHostBinding();
  const discoveryConcluded = useHostDiscoveryConcluded();
  const computers = useReportOtherComputers(args.chatHostId);
  const holdOver = useDeadlineReached(
    args.reportId === null
      ? null
      : args.preparedAtMs + REPORT_OTHER_HOST_LOGS_HOLD_MS,
  );
  const query = useQuery(
    supportOtherHostLogsQueryOptions({
      support: args.support,
      binding,
      draftId: args.draftId,
      reportId: args.reportId,
      computers,
    }),
  );
  const hasRow = (query.data ?? computers).length > 0;
  const outstanding = hasRow ? query.isPending : !discoveryConcluded;
  return {
    query: hasRow ? query : null,
    frozen: hasRow && query.isSuccess,
    pending:
      args.included &&
      args.reportId !== null &&
      binding !== null &&
      !holdOver &&
      outstanding,
  };
}
