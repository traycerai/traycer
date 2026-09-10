import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type { DraftDocument, DraftPublication } from "@traycer/protocol/host";
import type { DraftHeadReaderRecord } from "@traycer/protocol/persistence/draft/schemas";

const CLOUD_PUBLICATION: DraftPublication = {
  status: "current",
  lastPublishedAt: null,
  publishedRevision: null,
  halted: null,
};

/**
 * Project a published draft head (byte-pipe) onto the host-wire
 * `DraftDocument` the local stores already apply. Origin is always
 * replica: this host did not author the row. Foreign workspace
 * snapshots are dropped (decision #11).
 */
export function draftDocumentFromCloudHead(
  summary: CloudChatSummary,
  record: DraftHeadReaderRecord,
): DraftDocument {
  const publication: DraftPublication = {
    ...CLOUD_PUBLICATION,
    lastPublishedAt: summary.publishedAt,
  };
  const common = {
    draftId: summary.identity.chatId,
    target: record.target,
    revision: 0,
    lastTouchedAt: record.lastTouchedAt,
    workspace: null,
    ownerHostId: summary.ownerHostId,
    origin: "replica" as const,
    adoption: { state: "adopted" as const, hostId: summary.ownerHostId },
    publication,
  };
  if (record.kind === "stash-entry") {
    return {
      ...common,
      kind: "stash-entry",
      portable: record.portable,
    };
  }
  if (record.kind === "interview") {
    return {
      ...common,
      kind: "interview",
      portable: record.portable,
    };
  }
  return {
    ...common,
    kind: record.surfaceKind,
    portable: record.portable,
  };
}
