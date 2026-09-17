import { currentDraftBlobOwnerId } from "@/lib/drafts/draft-blob-transport";
import { useEffect, useRef } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { TimerHandle } from "@traycer-clients/shared/host-transport/timer-handle";
import { webCryptoSha256Hex } from "@traycer-clients/shared/cloud-chat/bytes";
import type { HostRpcRegistry } from "@/lib/host";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
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
import {
  flushAbsentOwnCloudDrafts,
  ingestCloudDraftSummary,
  reserveCloudDraftIngestFence,
  sweepAbsentCloudDraftMirrors,
} from "@/lib/drafts/draft-mirror-coordinator";
import { cloudDraftIdentityKey } from "@/lib/drafts/cloud-draft-identity";
import { useCloudDraftsDirectory } from "./use-cloud-drafts-directory";

function ingestKey(summary: CloudChatSummary): string {
  return `${cloudDraftIdentityKey(summary)}:${summary.headSha256}`;
}

/**
 * Whether the guard may skip a listed head: the identity key (owner plus
 * head) was already ingested by this mount. Ownership never moves, so a row
 * whose owner differs from the listing is a different row under the same
 * id, which a new key already covers.
 */
function guardMaySkip(
  ingestedKeys: ReadonlyMap<string, string>,
  summary: CloudChatSummary,
): boolean {
  return ingestedKeys.has(ingestKey(summary));
}

/** Attempts per head, including the first. Bounded, with exponential spacing. */
const MAX_HEAD_READ_ATTEMPTS = 3;
const HEAD_READ_RETRY_BASE_MS = 2_000;

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
  // Destructured so the effect depends on the (stable) reader, not on the
  // directory object a method call would otherwise bind.
  const { snapshotIngestSeq } = directory;
  // Guard key -> chat id: a key is released when the absence sweep drops
  // that chat's mirror, so the same head listed again later is read again.
  const ingested = useRef(new Map<string, string>());
  // Own rows already nudged (`flushAbsentOwnCloudDrafts`) for a directory
  // snapshot, keyed by that snapshot's fence: once per snapshot, not on
  // every effect run that re-reads the same settled directory.
  const nudged = useRef<{ fenceSeq: number; ids: Set<string> }>({
    fenceSeq: -1,
    ids: new Set(),
  });
  useEffect(() => {
    ingested.current.clear();
    nudged.current = { fenceSeq: -1, ids: new Set() };
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
    // Copied out of the ref so the cleanup closes over the SET rather than
    // reading `.current` at teardown (react-hooks forbids the latter, and CI
    // lints with --deny-warnings). The ref is only ever mutated, never
    // reassigned, so this is the same set for the component's life.
    const ingestedKeys = ingested.current;
    // Two teardown obligations, and both exist because a key is claimed BEFORE
    // the work that clears it finishes:
    //   - a pending retry is waiting on a timer, and
    //   - an in-flight read has not settled yet.
    // In both cases the key sits in `ingestedKeys`, so the next run of this
    // effect would skip the row as already handled. Releasing only at settle
    // time is too late: the next setup has already walked the list by then.
    // So teardown clears the timers AND releases every key still unsettled,
    // and the chains themselves return without touching the set once aborted.
    const pendingTimers = new Set<TimerHandle>();
    const unsettledKeys = new Set<string>();
    const tornDown = (): boolean => scope.signal.aborted;
    const foreign = directory.chats.filter(
      (chat) => chat.ownerHostId !== hostId,
    );
    // A replica whose row the directory no longer lists was deleted on its
    // owner; drop the mirror so it leaves the list here too. Only against a
    // fetched directory - an empty pending one lists nothing. The absence
    // set is EVERY listed row, not the foreign ones: a row this host owns
    // (forked here, or listed ahead of this window's hydration) is listed
    // under this host's ownership and is not absent.
    // The heads this run will read, reserved BEFORE the sweep: a draft the
    // directory lists under an owner other than the one a clean local
    // replica names must be re-read, not dropped by the owner-aware absence
    // check below and re-created by the ingest, reconciling away an open
    // tab in between. Its summary is a new key, so it is always among these.
    const toRead = foreign.filter(
      (summary) => !guardMaySkip(ingestedKeys, summary),
    );
    for (const summary of toRead) {
      reserveCloudDraftIngestFence(summary.identity.chatId);
    }
    if (directory.settled) {
      // Every listed row, keyed by id with the owners it is listed under:
      // cloud ids are host-minted, so absence is judged per (id, owner).
      const listed = new Map<string, Set<string>>();
      for (const chat of directory.chats) {
        const owners = listed.get(chat.identity.chatId) ?? new Set<string>();
        owners.add(chat.ownerHostId);
        listed.set(chat.identity.chatId, owners);
      }
      const fenceSeq = snapshotIngestSeq();
      const dropped = new Set(
        sweepAbsentCloudDraftMirrors(hostId, listed, fenceSeq),
      );
      if (dropped.size > 0) {
        for (const [key, chatId] of ingestedKeys) {
          if (dropped.has(chatId)) ingestedKeys.delete(key);
        }
      }
      // An own row the directory no longer lists is the owner host's to
      // settle (delete if unchanged, re-mint if edited): nudge its mounted
      // session with a flush so it probes the cloud, once per snapshot.
      if (nudged.current.fenceSeq !== fenceSeq) {
        nudged.current = { fenceSeq, ids: new Set() };
      }
      const alreadyNudged = nudged.current.ids;
      for (const id of flushAbsentOwnCloudDrafts(
        listed,
        fenceSeq,
        alreadyNudged,
      )) {
        alreadyNudged.add(id);
      }
    }
    for (const summary of foreign) {
      // The owner-led identity key plus the head. Both halves are
      // load-bearing. `headSha256` is there because the identity alone is
      // stable across publishes, so a newer head for the same draft used to
      // hit this guard and be skipped, leaving the replica stale.
      // `ownerHostId` is there because the key names a ROW, not an id: a
      // fork or re-mint elsewhere publishes under a fresh id, but an id the
      // directory lists under another owner than this mount last ingested
      // is not the head it recorded.
      const key = ingestKey(summary);
      if (guardMaySkip(ingestedKeys, summary)) continue;
      ingestedKeys.set(key, summary.identity.chatId);
      unsettledKeys.add(key);
      const settle = (): void => {
        unsettledKeys.delete(key);
      };
      const attemptRead = async (attempt: number): Promise<void> => {
        // Reserved BEFORE the head read: another mount's older directory
        // snapshot settling during the read must not sweep the mirror this
        // head is about to refresh (and clear its active surface with it).
        reserveCloudDraftIngestFence(summary.identity.chatId);
        // And the ACCOUNT this read is for, captured at the same point and for
        // the same reason. A head read that finishes after a switch carries the
        // previous account's draft; capturing the owner where the apply STARTS
        // reads the new one and installs that text under it. The request knows
        // whose it is; its continuation does not.
        const readOwner = currentDraftBlobOwnerId();
        let outcome: CloudDraftReadOutcome;
        try {
          outcome = await readCloudDraft({
            identity: summary.identity,
            port,
            sha256Hex: webCryptoSha256Hex,
          });
        } catch (error: unknown) {
          // Teardown owns the key once the scope is aborted - see above.
          if (scope.signal.aborted) return;
          const nextAttempt = attempt + 1;
          if (nextAttempt >= MAX_HEAD_READ_ATTEMPTS) {
            // Out of attempts. Release the guard so a later run of this effect
            // - or the fresh `ingested` set a remount brings - can ask again,
            // rather than leaving the row hidden for good.
            settle();
            ingestedKeys.delete(key);
            appLogger.warn("[cloud-drafts] head read failed", {
              attempts: nextAttempt,
              error: describeLogError(error),
            });
            return;
          }
          const timer = setTimeout(
            () => {
              pendingTimers.delete(timer);
              void attemptRead(nextAttempt);
            },
            HEAD_READ_RETRY_BASE_MS * 2 ** attempt,
          );
          pendingTimers.add(timer);
          return;
        }
        if (scope.signal.aborted) return;
        // A SETTLED refusal - unpublished, corrupt, needs-newer-app - stays
        // marked rather than retried: it is terminal for THIS head, and a head
        // that later publishes arrives under a new `headSha256`, so it lands
        // in this loop under a new key.
        if (outcome.kind !== "ok") {
          settle();
          return;
        }
        const document = draftDocumentFromCloudHead(summary, outcome.record);
        // The key stays unsettled through the apply, so a teardown that
        // interrupts it still releases the guard.
        try {
          await ingestCloudDraftSummary({
            hostId,
            summary,
            document,
            readOwner,
          });
          settle();
        } catch (error: unknown) {
          // Re-read through the scope: the earlier check narrowed the
          // property, and the await above may have torn the effect down.
          if (tornDown()) return;
          // The store is the only projection this row has on this device, so
          // a failed apply (a blob read or write that threw) is retried on
          // the same bounded schedule as a failed head read; nothing else
          // would re-run this effect. Out of attempts, release the guard so
          // a later run (or a remount) asks again.
          const nextAttempt = attempt + 1;
          if (nextAttempt >= MAX_HEAD_READ_ATTEMPTS) {
            settle();
            ingestedKeys.delete(key);
            appLogger.warn("[cloud-drafts] head apply failed", {
              attempts: nextAttempt,
              error: describeLogError(error),
            });
            return;
          }
          const timer = setTimeout(
            () => {
              pendingTimers.delete(timer);
              void attemptRead(nextAttempt);
            },
            HEAD_READ_RETRY_BASE_MS * 2 ** attempt,
          );
          pendingTimers.add(timer);
        }
      };
      void attemptRead(0);
    }
    return () => {
      scope.abort();
      for (const timer of pendingTimers) clearTimeout(timer);
      pendingTimers.clear();
      for (const pendingKey of unsettledKeys) ingestedKeys.delete(pendingKey);
      unsettledKeys.clear();
    };
  }, [
    client,
    directory.chats,
    directory.settled,
    directory.visible,
    hostId,
    snapshotIngestSeq,
  ]);
}
