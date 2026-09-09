import { useEffect, useRef } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { webCryptoSha256Hex } from "@traycer-clients/shared/cloud-chat/bytes";
import type { HostRpcRegistry } from "@/lib/host";
import { createHostCloudChatReadPort } from "@/lib/chats/cloud-chat-read-port";
import { readCloudDraft } from "@/lib/drafts/cloud-draft-reader";
import { draftDocumentFromCloudHead } from "@/lib/drafts/cloud-draft-apply";
import { ingestCloudDraftSummary } from "@/lib/drafts/draft-mirror-coordinator";
import { useCloudDraftsDirectory } from "./use-cloud-drafts-directory";

/**
 * Byte-pipe ingest of published drafts owned by another host. Hidden
 * capability (free-tier / old host) never runs. Same-host rows are
 * already live via `drafts.subscribe`.
 */
export function useCloudDraftsIngest(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
): void {
  const directory = useCloudDraftsDirectory(client, hostId);
  const ingested = useRef(new Set<string>());
  useEffect(() => {
    ingested.current.clear();
  }, [directory.scopeId]);
  useEffect(() => {
    if (!directory.visible || client === null || hostId === null) return;
    const port = createHostCloudChatReadPort(client);
    // The reads below are detached, so a host or scope change while one is in
    // flight would otherwise let it hand a stale record to the global draft
    // stores. `ingestCloudDraftSummary` validates neither.
    const scope = new AbortController();
    const foreign = directory.chats.filter(
      (chat) => chat.ownerHostId !== hostId,
    );
    for (const summary of foreign) {
      // `headSha256` is in the key on purpose: the identity alone is stable
      // across publishes, so a newer head for the same draft hit this guard
      // and was skipped, leaving the replica stale until the scope changed.
      const key = `${summary.identity.taskId}:${summary.identity.chatId}:${summary.identity.ownerUserId}:${summary.headSha256}`;
      if (ingested.current.has(key)) continue;
      ingested.current.add(key);
      void (async () => {
        const outcome = await readCloudDraft({
          identity: summary.identity,
          port,
          sha256Hex: webCryptoSha256Hex,
        });
        if (scope.signal.aborted || outcome.kind !== "ok") return;
        const document = draftDocumentFromCloudHead(summary, outcome.record);
        await ingestCloudDraftSummary({ hostId, summary, document });
      })();
    }
    return () => {
      scope.abort();
    };
  }, [client, directory.chats, directory.visible, hostId]);
}
