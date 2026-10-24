import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { ENVIRONMENT_ITEM_KINDS } from "@traycer/protocol/host/environment-schemas";
import type {
  DetailsEntry,
  DetailsHistory,
  DetailsHostStatus,
  DetailsProviderContext,
  DetailsStatus,
  DetailsSubject,
} from "@/lib/settings-details-entry";
import { registerDetailsProvider } from "@/lib/settings-details-entry";
import { recoveryForHost } from "@/components/settings/details/details-copy";

import { loadSecretDetails } from "@/components/settings/details/secret-details-status";

type HistoryResponse = ResponseOfMethod<HostRpcRegistry, "environment.history">;
type HistorySubject = RequestOfMethod<
  HostRpcRegistry,
  "environment.history"
>["subject"];

const TITLES: Readonly<Record<string, string>> = {
  secret: "Secrets",
  member: "Member details",
  plan: "Plan details",
  host_settings: "Settings",
  move: "Move to Personal",
  chip: "Settings delivery",
};

function historySubject(subject: DetailsSubject): HistorySubject {
  if (subject.kind === "chip" || subject.key.length === 0) return null;
  return { kind: subject.kind, key: subject.key };
}

/** A host's state for the read's subject; the chip's subject names no item. */
function hostStatus(
  host: HistoryResponse["hostStates"][number],
  itemKind: string | null,
): DetailsHostStatus {
  return {
    hostId: host.hostId,
    name: host.hostName,
    item: null,
    state: host.state,
    reason: host.reason,
    at: host.at,
    lastReportedAt: host.lastReportedAt,
    recovery: recoveryForHost(host.state, host.reason, host.hostId, itemKind),
  };
}

function detailsHistory(history: HistoryResponse): DetailsHistory {
  return {
    readerScope: history.readerScope,
    entries:
      history.readerScope === "status_only"
        ? []
        : history.entries.map((entry) => ({
            at: entry.at,
            actor: entry.actor,
            operation: entry.operation,
            outcome: entry.outcome,
            hosts: [],
          })),
  };
}

/** All reads here run inside the drawer's Query, including the fresh export read.
 * Current host names come only from the server's separately authorized status;
 * historical actor labels come only from its reader-filtered history.
 */
async function environmentDetailsProvider(
  subject: DetailsSubject,
  context: DetailsProviderContext,
): Promise<DetailsEntry> {
  const response = await context.client.request("environment.history", {
    environmentId: subject.environmentId,
    subject: historySubject(subject),
  });
  const history = detailsHistory(response);
  const latest = history.entries.toSorted((a, b) => b.at - a.at).at(0);
  let title = TITLES[subject.kind] ?? "Settings";
  let status: DetailsStatus = {
    summary: "Current status",
    currentVersion: null,
    changedBy: latest?.actor?.label ?? null,
    changedAt: latest?.at ?? null,
    reason: null,
    hosts: response.hostStates.map((host) =>
      hostStatus(host, historySubject(subject)?.kind ?? null),
    ),
  };
  if (subject.kind === "secret") {
    const secret = await loadSecretDetails(subject, context, status);
    title = secret.title;
    status = secret.status;
  }

  return {
    subject,
    title,
    status: () => status,
    history: () => history,
    exportDiagnostics: async () => {
      // Retrieval rechecks the reader's authorization, even while the drawer stays open.
      const fresh = await environmentDetailsProvider(subject, context);
      return {
        subject,
        title: fresh.title,
        exportedAt: Date.now(),
        status: fresh.status(),
        history: fresh.history(),
      };
    },
  };
}

for (const kind of [
  ...ENVIRONMENT_ITEM_KINDS,
  "plan",
  "host_settings",
  "move",
  "chip",
]) {
  registerDetailsProvider(kind, environmentDetailsProvider);
}
