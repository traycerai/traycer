import { useMemo } from "react";
import {
  queryOptions,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { isRemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  MAX_REPORT_OTHER_HOST_LOGS,
  REPORT_OTHER_HOST_LOG_TAIL_LINES,
} from "@traycer-clients/shared/support/image-attachment-guards";
import { useConnectableHostIds } from "@/hooks/host/use-connectable-host-ids";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import { computerNameFromLabel } from "@/lib/host/host-name";
import { runnerQueryKeys, supportBridgeQueryScopeId } from "@/lib/query-keys";
import type { DesktopSupportBridge } from "@/lib/windows/types";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";

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
        version: entry.version,
      }));
  }, [chatHostId, connectable.hostIds, directory.data]);
}

async function readHostLogTail(
  binding: HostRuntimeBinding<HostRpcRegistry> | null,
  hostId: string,
  signal: AbortSignal,
): Promise<readonly string[] | null> {
  const client = resolveNamedHostClient(binding, hostId);
  if (client === null) return null;
  try {
    const tail = await client.requestWithSignal(
      "diagnostics.logs.tail",
      { target: "host", tailLines: REPORT_OTHER_HOST_LOG_TAIL_LINES },
      signal,
    );
    return tail.status === "available" ? tail.lines : null;
  } catch (error) {
    // A cancelled read is the query being torn down, not a computer that did
    // not answer: it must not freeze as one.
    if (signal.aborted) throw error;
    return null;
  }
}

/**
 * Reads the host log tail of each of `computers` and freezes them onto one
 * report. Keyed by the report and never stale, so it runs once per report:
 * the computers and tails are the ones read when the report was prepared,
 * like the local tails beside them, whatever the directory does afterwards.
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
   * Resolves once the tails are frozen or could not be. A send or a saved
   * bundle awaits it, so what ships never depends on how quickly the person
   * pressed the button.
   */
  readonly settle: () => Promise<void>;
}

/**
 * The other connected computers' host log tails for one report draft.
 * `reportId` is null until the draft's local evidence is frozen.
 */
export function useSupportOtherHostLogsQuery(args: {
  readonly support: DesktopSupportBridge | null;
  readonly draftId: number;
  readonly reportId: string | null;
  readonly chatHostId: string | null;
}): SupportOtherHostLogs {
  const queryClient = useQueryClient();
  const binding = useHostBinding();
  const computers = useReportOtherComputers(args.chatHostId);
  const options = supportOtherHostLogsQueryOptions({
    support: args.support,
    binding,
    draftId: args.draftId,
    reportId: args.reportId,
    computers,
  });
  const query = useQuery(options);
  if ((query.data ?? computers).length === 0) {
    return { query: null, settle: () => Promise.resolve() };
  }
  return {
    query,
    settle: async () => {
      await queryClient.ensureQueryData(options).catch(() => null);
    },
  };
}
