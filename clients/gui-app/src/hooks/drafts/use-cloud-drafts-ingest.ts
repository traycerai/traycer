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
  abandonCloudDraftHeadRead,
  beginCloudDraftHeadRead,
  cloudDraftHeadKey,
  cloudDraftHeadReading,
  cloudDraftHeadSettled,
  flushAbsentOwnCloudDrafts,
  ingestCloudDraftSummary,
  noteCloudDraftHeadHost,
  releaseCloudDraftHeadRead,
  reserveCloudDraftIngestFence,
  reserveCloudDraftSweepFence,
  settleCloudDraftHeadWithoutApply,
  subscribeCloudDraftHeadAbandoned,
  sweepAbsentCloudDraftMirrors,
} from "@/lib/drafts/draft-mirror-coordinator";
import { useCloudDraftsDirectory } from "./use-cloud-drafts-directory";

/**
 * Whether a mount may skip a listed row: it has no head yet (nothing to
 * resolve; a first publish arrives as a new `headSha256`), or the coordinator
 * has it in hand - another mount is reading it now, or a mount of this
 * renderer settled it and the settlement still stands (its mirror is still in
 * the landing store, or it settled without one and the row has not been
 * republished since). The coordinator is the ONLY memory consulted: this hook
 * mounts on the landing page and in every tab, and a per-mount set once kept
 * beside it is what made each mount a full fan-out through the host, N-fold
 * when N tabs restored at once. Kept as a second vote it was also wrong
 * whenever the coordinator forgot a head on purpose: a republication of the
 * same digest, or a mirror removed by any road but the absence sweep (a
 * delete, a stash retirement, another owner's row installed over its id). The
 * mount that had read the head held the key, so the one mount that would
 * have restored the mirror skipped it until it remounted. Every reason the
 * coordinator forgets a head is a reason to read it again, and the
 * coordinator's record covers every reason to skip (a read in flight, a
 * settled mirror still present, a refusal or install that settled without
 * one), so a mount keeps no vote of its own. Ownership never moves, so a row
 * whose owner differs from the listing is a different row under the same id,
 * and a different coordinator key.
 */
function guardMaySkip(summary: CloudChatSummary): boolean {
  return summary.headSha256 === null || cloudDraftHeadSettled(summary);
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
  // Own rows already nudged (`flushAbsentOwnCloudDrafts`) for a directory
  // snapshot, keyed by that snapshot's fence: once per snapshot, not on
  // every effect run that re-reads the same settled directory. The only
  // memory this hook keeps across runs: which heads to skip is the
  // coordinator's to remember (`guardMaySkip`).
  const nudged = useRef<{ fenceSeq: number; ids: Set<string> }>({
    fenceSeq: -1,
    ids: new Set(),
  });
  useEffect(() => {
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
    // Two teardown obligations, and both exist because a head is claimed in
    // the coordinator BEFORE the work that settles it finishes:
    //   - a pending retry is waiting on a timer, and
    //   - an in-flight read has not settled yet.
    // In both cases the coordinator's process-wide "reading" record is what
    // keeps every mount off the head - this one's next run included - and
    // settling only when the read decides is too late: the next setup has
    // already walked the list by then. So teardown clears the timers AND
    // abandons every head still unsettled (`unsettledKeys`), which wakes the
    // mounts that skipped it, and the chains themselves return without
    // touching the coordinator once aborted.
    const pendingTimers = new Set<TimerHandle>();
    const unsettledKeys = new Map<string, CloudChatSummary>();
    // Heads whose read this run gave up on. Giving up abandons the claim so
    // a mount on another host reads the head through its own pipe; this set
    // keeps an EXHAUSTION wake from restarting the read that just failed,
    // here, until the next directory delivery re-runs this effect: this
    // run's own, and a sibling's that ran out of attempts on the same
    // publication after taking it over, or two failing mounts would trade
    // the head at the ladder's pace for as long as the refusals last. A
    // RELEASE wake for the same publication is taken: the sibling that took
    // the head over was torn down with it undecided, and nothing says the
    // read would fail now. Keyed by head AND publication, and looked up by
    // THIS run's listing of the head, not the abandoning mount's: a later
    // republication of the same digest is a different publication, which
    // this run lists only once a delivery has re-run it with a fresh set,
    // and a sibling listing the republication while this run still lists
    // the earlier one must not trade the head with it.
    const exhaustedKeys = new Set<string>();
    const exhaustedKeyOf = (summary: CloudChatSummary): string =>
      `${cloudDraftHeadKey(summary)}@${summary.publishedAt ?? "unpublished"}`;
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
    // Every listed head is reserved BEFORE the sweep, whether this run reads
    // it or not, and whichever host owns it. A draft the directory lists
    // under an owner other than the one a clean local replica names must be
    // re-read, not dropped by the owner-aware absence check below and
    // re-created by the ingest, reconciling away an open tab in between. And
    // a positive listing has to ORDER against older snapshots: with two
    // host-scoped directories, a later-dispatched response that lists a row
    // can run before an earlier-dispatched one that omits it, and the older
    // sweep must find the row reserved past its own fence. That holds for a
    // row this mount's host owns too: the other host's directory lists it as
    // foreign, and its older absence sweep judges the row's mirror by the
    // same fence, so a positive listing here that left no fence would let
    // that sweep drop a published row whose owning session had since
    // unmounted. Before the coordinator held the record, a mount's first
    // walk reserved every head because it read every head; this keeps that
    // ordering for the heads it now skips, at the cost of one map write per
    // listed row per walk. The SWEEP fence, not the ingest fence: the ingest
    // fence is also the apply's supersession check, and a walk that merely
    // lists a row must not abandon the apply another mount has in flight
    // for it. A head this run reads reserves the ingest fence itself,
    // before its read.
    // Stamped at this directory's dispatch position, not at the walk: a walk
    // of a cached snapshot can run after a newer request left, and a stamp
    // taken now would outrank that response's absence.
    const listedAtSeq = snapshotIngestSeq();
    for (const summary of directory.chats) {
      if (summary.headSha256 === null) continue;
      reserveCloudDraftSweepFence(
        summary.identity.chatId,
        summary.ownerHostId,
        listedAtSeq,
      );
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
      // A dropped mirror ends its coordinator record there, so a later
      // listing of the same head is read again; no memory here to release.
      sweepAbsentCloudDraftMirrors(hostId, listed, fenceSeq);
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
    const startRead = (summary: CloudChatSummary): void => {
      // The owner-led identity key plus the head, the coordinator's own key
      // for the claim below: what teardown abandons if the read is still
      // undecided then.
      const key = cloudDraftHeadKey(summary);
      unsettledKeys.set(key, summary);
      // Claimed process-wide BEFORE the read: a second mount walking the same
      // directory in the same tick (N tabs restored into one Task) skips the
      // head instead of reading it too. The coordinator settles or releases
      // the claim when the read decides; the two exhausted-attempt exits and
      // teardown below abandon it themselves (waking the mounts that skipped
      // the head), an ambiguous identity releases it, and a retry that finds
      // the claim displaced by a newer head stops without releasing, because
      // the claim is not its own any more.
      beginCloudDraftHeadRead(summary);
      // A host of the row from the moment it reads, whatever the read
      // decides: a read that settles without an install (unpublished,
      // corrupt, needs a newer app) or gives the head back still leaves this
      // host's directory cached at the head, and a later head of the row
      // that settles with images on another host must register this host as
      // a source for them, as it does a host that merely listed the row.
      noteCloudDraftHeadHost(summary, hostId);
      const settle = (): void => {
        unsettledKeys.delete(key);
      };
      const attemptRead = async (attempt: number): Promise<void> => {
        // A retry runs on a timer, and the claim it is retrying may be gone
        // by then. Two ways, told apart by what the guard says about the
        // head now. A newer head's read displaced it and is applying: the
        // retry must not advance the ingest fence below, because that fence
        // is also the apply's supersession check, and advancing it would
        // abandon the newer head's apply and then install this older one
        // over it; the guard answers settled (the listing is older than the
        // record) and the retry stops. Or the claim was dropped under this
        // mount - a torn-down mount's apply, superseded by this very claim's
        // fence reservation, released the row by digest - and nothing holds
        // the head: the guard answers not settled, and the retry claims it
        // again rather than leaving the head to nobody. The first attempt
        // holds the claim it just made.
        if (attempt > 0 && !cloudDraftHeadReading(summary)) {
          if (cloudDraftHeadSettled(summary)) {
            settle();
            return;
          }
          beginCloudDraftHeadRead(summary);
        }
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
          // Teardown owns the claim once the scope is aborted - see above.
          if (scope.signal.aborted) return;
          const nextAttempt = attempt + 1;
          if (nextAttempt >= MAX_HEAD_READ_ATTEMPTS) {
            // Out of attempts. Give the claim back so a later run of this
            // effect can ask again, rather than leaving the row hidden for
            // good. Abandoned in the coordinator, not merely released: a
            // mount bound to another host reads it through its own pipe now.
            // This mount's own wake is ignored (`exhaustedKeys`).
            settle();
            exhaustedKeys.add(exhaustedKeyOf(summary));
            abandonCloudDraftHeadRead(summary, "exhausted");
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
        // A SETTLED refusal - unpublished, corrupt, needs-newer-app - is
        // settled in the coordinator rather than retried: it is terminal for
        // THIS head, and a head that later publishes arrives under a new
        // `headSha256`, so it lands in this loop under a new key. Without the
        // record every later mount would resolve the same head again for the
        // same answer - for an app older than the heads it is shown, the
        // whole fan-out over again. One kind is NOT about the head: an
        // ambiguous identity is the server's precedence among rows for the
        // viewer, which can change under the same sha, so that claim is
        // released and every mount asks again at its next directory
        // delivery, this one included. Released, not abandoned: a mount
        // woken now would ask the same precedence
        // milliseconds later and spend its one ask on the same answer, and
        // the change that resolves the precedence - a row of the viewer's
        // published, retracted or re-owned - is itself a directory change,
        // so the delivery that carries it is the right time to ask.
        if (outcome.kind !== "ok") {
          if (outcome.kind === "ambiguous-identity") {
            releaseCloudDraftHeadRead(summary);
          } else {
            settleCloudDraftHeadWithoutApply(summary);
          }
          settle();
          return;
        }
        const document = draftDocumentFromCloudHead(summary, outcome.record);
        // The key stays unsettled through the apply, so a teardown that
        // interrupts it still abandons the claim.
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
          // would re-run this effect. Out of attempts, give the claim back so
          // a later run asks again.
          const nextAttempt = attempt + 1;
          if (nextAttempt >= MAX_HEAD_READ_ATTEMPTS) {
            settle();
            exhaustedKeys.add(exhaustedKeyOf(summary));
            abandonCloudDraftHeadRead(summary, "exhausted");
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
    };
    for (const summary of foreign) {
      if (guardMaySkip(summary)) {
        // Skipped, but this host still registers as a source for the head's
        // images (once per host; a no-op for a head without any, or one this
        // host already ingested), and is remembered on the row so a stash
        // entry's conversion can ask it for the bytes the reading host
        // misses.
        noteCloudDraftHeadHost(summary, hostId);
        continue;
      }
      startRead(summary);
    }
    // A head this run skipped because another mount was reading it is picked
    // up here if that mount is torn down before its read decides, or gives
    // the read up: the abandon releases the claim and names the head, and
    // this mount reads it now instead of at its next directory delivery.
    // Only a head this run's directory lists, never an exhaustion of a
    // publication this run gave up on itself (`exhaustedKeys`), and only
    // when nothing has it (the guard is asked again: a third mount may have
    // claimed it first).
    const unsubscribeAbandoned = subscribeCloudDraftHeadAbandoned(
      (abandoned, cause) => {
        if (tornDown()) return;
        const abandonedKey = cloudDraftHeadKey(abandoned);
        // What THIS run lists under the head's key, which is what it would
        // read, and whose publication is what it may have exhausted.
        const listed = foreign.find(
          (summary) => cloudDraftHeadKey(summary) === abandonedKey,
        );
        if (listed === undefined) return;
        // A head this run is already reading has its reader. The claim it
        // holds can be dropped under it (a torn-down continuation's release,
        // then a sibling's teardown abandoning the record that replaced it),
        // and the guard below would then find nothing and start a second
        // chain for the same head in this run - two reads from one mount,
        // and one `unsettledKeys` entry covering both, so the first to settle
        // would strip the other's teardown obligation. The chain in flight
        // re-claims on its own retry if the record is gone by then.
        if (unsettledKeys.has(abandonedKey)) return;
        const ignored = (): boolean =>
          cause === "exhausted" && exhaustedKeys.has(exhaustedKeyOf(listed));
        if (ignored()) return;
        // Deferred past the commit that abandoned the head. When a directory
        // delivery re-runs EVERY mount at once (a refetch moves the fence
        // sequence this effect depends on), React runs every cleanup before
        // any setup: the first mount's teardown abandons its reads in flight
        // while the others' old runs are still subscribed, and a wake taken
        // synchronously there would start the reads in a run about to be
        // torn down, which abandons them to the next, and so on down the
        // mounts - every read sent once per mount, the fan-out this guard
        // exists to remove. After the commit the old runs are torn down and
        // return here; the new runs find the heads unclaimed on their own
        // walk and read each once. A mount torn down alone (a tab closed)
        // still wakes the survivors, one microtask later.
        queueMicrotask(() => {
          if (tornDown() || ignored() || guardMaySkip(listed)) return;
          startRead(listed);
        });
      },
    );
    return () => {
      unsubscribeAbandoned();
      scope.abort();
      for (const timer of pendingTimers) clearTimeout(timer);
      pendingTimers.clear();
      // Abandoned, not merely released: a surviving mount that skipped one of
      // these heads is woken to read it.
      for (const pendingSummary of unsettledKeys.values()) {
        abandonCloudDraftHeadRead(pendingSummary, "released");
      }
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
