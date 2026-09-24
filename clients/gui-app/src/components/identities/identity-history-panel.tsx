/**
 * Per-file version history for one identity file: the newest page from
 * `agentIdentity.history.list` (a query), older pages fetched on demand (a
 * mutation, merged by observation id), and a restore that always goes
 * preflight → confirm → execute with the preflight's hash as the fence, so a
 * restore raced by an agent write comes back `conflict` and is re-checked
 * rather than clobbering.
 *
 * A markdown file's history and a blob's history are the same list: the host
 * captures both kinds as observations, and `evolution` is the one provenance
 * the identity family adds (an evolution pass rewrote the file).
 */
import { useState, type ReactNode } from "react";
import { History, RotateCcw } from "lucide-react";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { AgentIdentityVersionEntry } from "@traycer/protocol/host/agent-identity/unary-schemas";
import {
  IDENTITY_PROVENANCE_LABELS,
  RESTORE_UNAVAILABLE_COPY,
  mergeIdentityHistoryPages,
} from "@/lib/identities/history";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import {
  useIdentityHistoryLoadOlderForClient,
  useIdentityHistoryRestoreForClient,
} from "@/hooks/identities/use-identity-mutations";
import {
  IDENTITY_HISTORY_PAGE_SIZE,
  useIdentityHistoryListForClient,
} from "@/hooks/identities/use-identity-queries";
import type { HostRpcRegistry } from "@/lib/host";
import { formatRelativeTimestamp, useSampledNow } from "@/lib/relative-time";
import { cn } from "@/lib/utils";

export interface IdentityHistoryPanelProps {
  readonly identityId: string;
  readonly path: string | null;
}

type RestoreResponse = ResponseOfMethod<
  HostRpcRegistry,
  "agentIdentity.history.restore"
>;
type RestorePreflight = Extract<RestoreResponse, { kind: "preflight" }>;

export function IdentityHistoryPanel(
  props: IdentityHistoryPanelProps,
): ReactNode {
  const { identityId, path } = props;
  const client = useTabHostClient();
  const listQuery = useIdentityHistoryListForClient(client, {
    identityId,
    path,
  });
  const loadOlder = useIdentityHistoryLoadOlderForClient(client);
  const restore = useIdentityHistoryRestoreForClient(client);
  const [olderEntries, setOlderEntries] = useState<
    readonly AgentIdentityVersionEntry[]
  >([]);
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(
    undefined,
  );
  const [restoreTarget, setRestoreTarget] =
    useState<AgentIdentityVersionEntry | null>(null);
  const [preflight, setPreflight] = useState<RestorePreflight | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const now = useSampledNow();

  if (path === null) {
    return (
      <PanelNotice testId="identity-history-empty">
        Pick a file to see its history.
      </PanelNotice>
    );
  }
  if (listQuery.data === undefined) {
    if (listQuery.isError) {
      return (
        <PanelNotice testId="identity-history-failed">
          Couldn&apos;t load this file&apos;s history.
        </PanelNotice>
      );
    }
    return (
      <div
        className="flex flex-col gap-2 p-3"
        aria-busy="true"
        data-testid="identity-history-loading"
      >
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-10 w-full rounded-md" />
        ))}
      </div>
    );
  }

  const entries = mergeIdentityHistoryPages(
    listQuery.data.entries,
    olderEntries,
  );
  // The cursor to continue from: the newest page's until an older page has
  // answered, then that page's. `null` means the host said there is no more.
  const nextCursor =
    olderCursor === undefined ? listQuery.data.nextCursor : olderCursor;

  const requestOlder = () => {
    if (nextCursor === null) return;
    loadOlder.mutate(
      {
        identityId,
        path,
        cursor: nextCursor,
        limit: IDENTITY_HISTORY_PAGE_SIZE,
      },
      {
        onSuccess: (response) => {
          setOlderEntries((held) => [...held, ...response.entries]);
          setOlderCursor(response.nextCursor);
        },
      },
    );
  };

  const requestPreflight = (entry: AgentIdentityVersionEntry) => {
    setRestoreTarget(entry);
    setPreflight(null);
    setNotice(null);
    restore.mutate(
      {
        identityId,
        path,
        targetObservationId: entry.observationId,
        mode: "preflight",
        expectedCurrentHash: null,
      },
      {
        onSuccess: (response) => {
          if (response.kind === "preflight") {
            setPreflight(response);
            return;
          }
          setRestoreTarget(null);
          if (response.kind === "unavailable") {
            setNotice(RESTORE_UNAVAILABLE_COPY[response.reason]);
          }
        },
        onError: () => {
          setRestoreTarget(null);
        },
      },
    );
  };

  const executeRestore = () => {
    if (restoreTarget === null || preflight === null) return;
    const target = restoreTarget;
    restore.mutate(
      {
        identityId,
        path,
        targetObservationId: target.observationId,
        mode: "execute",
        expectedCurrentHash: preflight.currentHash,
      },
      {
        onSuccess: (response) => {
          if (response.kind === "conflict") {
            // The file moved under the preflight: re-check against what is
            // current now and ask again, never restore over the newer bytes.
            requestPreflight(target);
            return;
          }
          setRestoreTarget(null);
          setPreflight(null);
          if (response.kind === "unavailable") {
            setNotice(RESTORE_UNAVAILABLE_COPY[response.reason]);
            return;
          }
          if (response.kind === "outcome") {
            setOlderEntries([]);
            setOlderCursor(undefined);
          }
        },
      },
    );
  };

  return (
    <div
      className="flex flex-col gap-2 p-2"
      data-testid="identity-history-panel"
    >
      {notice !== null ? (
        <p
          role="alert"
          data-testid="identity-history-notice"
          className="rounded-md border border-warning/30 bg-warning/10 px-2 py-1 text-ui-xs text-warning-foreground"
        >
          {notice}
        </p>
      ) : null}
      {entries.length === 0 ? (
        <PanelNotice testId="identity-history-none">
          <History className="size-4" />
          No versions captured yet.
        </PanelNotice>
      ) : null}
      <ol className="flex flex-col gap-1">
        {entries.map((entry, index) => (
          <li
            key={entry.observationId}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5",
              index === 0 ? "bg-foreground/5" : null,
            )}
            data-testid="identity-history-entry"
            data-observation-id={entry.observationId}
          >
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-ui-sm text-foreground">
                {IDENTITY_PROVENANCE_LABELS[entry.provenance.kind]}
              </span>
              <span className="text-ui-xs text-muted-foreground">
                {formatRelativeTimestamp(entry.capturedAt, now)}
                {entry.degraded ? " · degraded" : ""}
              </span>
            </div>
            {index === 0 ? (
              <Badge variant="muted" size="xs">
                current
              </Badge>
            ) : (
              <Button
                type="button"
                variant="muted"
                size="xs"
                aria-label="Restore this version"
                disabled={!entry.available || restore.isPending}
                onClick={() => requestPreflight(entry)}
                data-testid="identity-history-restore"
              >
                <RotateCcw className="size-3" />
                Restore
              </Button>
            )}
          </li>
        ))}
      </ol>
      {nextCursor !== null ? (
        <Button
          type="button"
          variant="muted"
          size="sm"
          disabled={loadOlder.isPending}
          onClick={requestOlder}
          data-testid="identity-history-load-older"
        >
          Load older
          {loadOlder.isPending ? <MutedAgentSpinner /> : null}
        </Button>
      ) : null}
      <ConfirmDestructiveDialog
        open={restoreTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRestoreTarget(null);
            setPreflight(null);
          }
        }}
        title="Restore this version?"
        description="The current content is kept in history, so this can be undone by restoring it back."
        cascadeSummary={null}
        actionLabel="Restore"
        isPending={restore.isPending}
        blockedReason={
          preflight === null && !restore.isPending
            ? "Checking the current version…"
            : null
        }
        onConfirm={executeRestore}
      />
    </div>
  );
}

function PanelNotice(props: {
  readonly testId: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div
      data-testid={props.testId}
      className="flex items-center justify-center gap-2 p-4 text-center text-ui-xs text-muted-foreground"
    >
      {props.children}
    </div>
  );
}
