import { useEffect, useRef } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { webCryptoSha256Hex } from "@traycer-clients/shared/cloud-chat/bytes";
import type { HostRpcRegistry } from "@/lib/host";
import { createHostCloudChatReadPort } from "@/lib/chats/cloud-chat-read-port";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import {
  readCloudDraft,
  type CloudDraftReadOutcome,
} from "@/lib/drafts/cloud-draft-reader";
import { appLogger, describeLogError } from "@/lib/logger";
import { draftDocumentFromCloudHead } from "@/lib/drafts/cloud-draft-apply";
import { ingestCloudDraftSummary } from "@/lib/drafts/draft-mirror-coordinator";
import { recordCloudDraftKind } from "@/lib/drafts/cloud-draft-kinds";
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
    // The verdict is re-read by the port before every head and part request,
    // as `use-cloud-chat-queries` does: a session demoted mid-ingest stops the
    // next read rather than the reads already in flight.
    const port = createHostCloudChatReadPort(client, () =>
      authorizesCloudCapability(useAuthStore.getState().status),
    );
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
        let outcome: CloudDraftReadOutcome;
        try {
          outcome = await readCloudDraft({
            identity: summary.identity,
            port,
            sha256Hex: webCryptoSha256Hex,
          });
        } catch (error: unknown) {
          // A transport failure must not leave this head marked handled. The
          // listing hides a row whose kind it does not know, so a guard that
          // survived a transient failure would hide a healthy draft for the
          // lifetime of this mount. Releasing the key lets the next run of
          // this effect ask again. (A SETTLED refusal - unpublished, corrupt,
          // needs-newer-app - stays marked: it is terminal for this head, and
          // a head that later publishes arrives under a new `headSha256`.)
          ingested.current.delete(key);
          appLogger.warn("[cloud-drafts] head read failed", {
            error: describeLogError(error),
          });
          return;
        }
        if (scope.signal.aborted) {
          ingested.current.delete(key);
          return;
        }
        if (outcome.kind !== "ok") return;
        const document = draftDocumentFromCloudHead(summary, outcome.record);
        // The head is the only place a row's surface kind is written, and this
        // is the only read of it - record before the ingest decides, so a
        // host-bound row the ingest declines is still known to the listing.
        recordCloudDraftKind(summary.identity, document.kind);
        await ingestCloudDraftSummary({ hostId, summary, document });
      })();
    }
    return () => {
      scope.abort();
    };
  }, [client, directory.chats, directory.visible, hostId]);
}
