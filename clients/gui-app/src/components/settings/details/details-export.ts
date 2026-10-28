import type {
  DetailsExport,
  DetailsHistory,
  DetailsHostStatus,
  DetailsRecovery,
  DetailsStatus,
  DetailsSubject,
} from "@/lib/settings-details-entry";

function exportSubject(subject: DetailsSubject): DetailsSubject {
  return {
    environmentId: subject.environmentId,
    kind: subject.kind,
    key: subject.key,
  };
}

function exportHost(host: DetailsHostStatus): DetailsHostStatus {
  const recovery = host.recovery;
  let exportedRecovery: DetailsRecovery | null = null;
  if (recovery !== null) {
    exportedRecovery =
      recovery.kind === "apply"
        ? {
            kind: recovery.kind,
            hostId: recovery.hostId,
            guestSetupFailed: recovery.guestSetupFailed,
          }
        : { kind: recovery.kind, hostId: recovery.hostId };
  }
  return {
    hostId: host.hostId,
    name: host.name,
    item: host.item,
    state: host.state,
    reason: host.reason,
    at: host.at,
    lastReportedAt: host.lastReportedAt,
    recovery: exportedRecovery,
  };
}

function exportStatus(status: DetailsStatus): DetailsStatus {
  return {
    summary: status.summary,
    currentVersion: status.currentVersion,
    changedBy: status.changedBy,
    changedAt: status.changedAt,
    reason: status.reason,
    hosts: status.hosts.map(exportHost),
    items: status.items?.map((item) => ({
      subject: exportSubject(item.subject),
      title: item.title,
      summary: item.summary,
      at: item.at,
      retryable: item.retryable,
    })),
  };
}

function exportHistory(history: DetailsHistory): DetailsHistory {
  return {
    readerScope: history.readerScope,
    entries:
      history.readerScope === "status_only"
        ? []
        : history.entries.map((entry) => ({
            at: entry.at,
            actor:
              entry.actor === null
                ? null
                : {
                    label: entry.actor.label,
                    tombstoned: entry.actor.tombstoned,
                  },
            operation: entry.operation,
            outcome: entry.outcome,
            hosts: entry.hosts.map(exportHost),
          })),
  };
}

/** Project every level: an accidentally extended provider cannot export payloads. */
export function serializeDetailsExport(exported: DetailsExport): string {
  const sanitized: DetailsExport = {
    subject: exportSubject(exported.subject),
    title: exported.title,
    exportedAt: exported.exportedAt,
    status: exportStatus(exported.status),
    history: exportHistory(exported.history),
  };
  return JSON.stringify(sanitized, null, 2);
}
