import { useMemo } from "react";
import {
  botDropNoticeId,
  type BotBoxHold,
} from "@/components/bots/bot-box-drops";
import type {
  BotComposerCarry,
  BotComposerNotice,
  BotComposerReading,
  BotComposerSeed,
  BotKeptDraft,
} from "@/components/bots/bot-message-composer";
import {
  admitHeldTransfer,
  refuseHeldOverflow,
} from "@/hooks/bots/use-bot-box-images";
import {
  useBotDraftActions,
  useBotDraftsStore,
  withoutAnswerFailure,
  type BotCarriedBlock,
  type BotHeldDrop,
  type BotThreadBoxDraft,
} from "@/stores/bots/bot-drafts-store";

const NO_HELD_DROPS: ReadonlyArray<BotHeldDrop> = [];

/**
 * A message box's unsent draft, kept under the bot (`useBotDraftsStore`) by
 * `key` so it outlives the box: what it held loads back into it as a seed,
 * and the box keeps it through `keptDraft`, with a failed send it offers
 * back beside it and the message it replies to. Answers moved off question cards wait there for the box
 * to add them (`moved`), beside what the box says about card answers
 * (`notice`): all but those a send still out carries, or the failed send
 * offered back holds, which the box adds only once that send failed or that
 * offer went. `key` is the message a thread hangs off, or the channel's own
 * conversation; `null` keeps nothing. A box whose stored draft's images are
 * still being read back waits (`reading`), holding none of it yet, and what
 * is dropped or picked on it meanwhile is held for it (`hold`, T386). What the
 * box does once its account has retired changes nothing.
 */
export function useKeptBoxDraft(
  botId: string,
  key: string | null,
): {
  readonly kept: BotThreadBoxDraft | null;
  readonly seed: BotComposerSeed | null;
  readonly keptDraft: BotKeptDraft | null;
  readonly moved: BotComposerCarry | null;
  readonly notice: BotComposerNotice | null;
  readonly reading: BotComposerReading | null;
  /** `null` where `key` is: such a box never waits, so nothing is held for it. */
  readonly hold: BotBoxHold | null;
} {
  const kept = useBotDraftsStore((state) =>
    key === null ? null : (state.threadBoxes[botId]?.[key] ?? null),
  );
  const unsent = useBotDraftsStore((state) =>
    key === null ? null : (state.unsentBoxes[botId]?.[key] ?? null),
  );
  const replyTo = kept?.replyTo ?? null;
  const carry = useBotDraftsStore((state) =>
    key === null ? null : (state.boxCarries[botId]?.[key] ?? null),
  );
  const draftMoves = useBotDraftsStore((state) =>
    key === null ? null : (state.draftMoves[botId]?.[key] ?? null),
  );
  const boxNotice = useBotDraftsStore((state) =>
    key === null ? null : (state.boxNotices[botId]?.[key] ?? null),
  );
  const waiting = useBotDraftsStore((state) =>
    key === null ? null : (state.boxesReading[botId]?.[key] ?? null),
  );
  const heldDrops = useBotDraftsStore((state) =>
    key === null ? null : (state.boxDrops[botId]?.[key] ?? null),
  );
  // The generation the actions below act for, read in the same render.
  const generation = useBotDraftsStore((state) => state.generation);
  const {
    typeThreadBox,
    offerUnsent,
    sendCarry,
    noticeBox,
    discardReadingBox,
    setReplyTarget,
    holdDrop,
    claimDrop,
    dropClaimHolds,
    settleDrop,
    releaseDrop,
  } = useBotDraftActions();
  const hold = useMemo<BotBoxHold | null>(
    () =>
      key === null
        ? null
        : {
            batches: heldDrops ?? NO_HELD_DROPS,
            begin: () => {
              const epoch = useBotDraftsStore.getState().dropEpochs[botId] ?? 0;
              return (transfer) => {
                // Signed out, another account in, or the bot forgotten since
                // the gesture began: it takes nothing and says nothing.
                const now = useBotDraftsStore.getState();
                if (
                  now.generation !== generation ||
                  (now.dropEpochs[botId] ?? 0) !== epoch
                ) {
                  return;
                }
                const admitted = admitHeldTransfer(transfer);
                const entries =
                  admitted.files.length + admitted.fileUrlPaths.length;
                if (entries === 0) return;
                const held = holdDrop(botId, key, epoch, admitted);
                if (held !== null && held < entries) refuseHeldOverflow();
              };
            },
            claim: () => {
              const taken = claimDrop(botId, key);
              if (taken === null || taken.claim === null) return null;
              const { id, claim } = taken;
              return {
                transfer: taken,
                holds: () => dropClaimHolds(botId, key, id, claim),
                settle: () => settleDrop(botId, key, id, claim),
                release: () => releaseDrop(botId, key, id, claim),
              };
            },
            noticeId: botDropNoticeId(botId, key),
          },
    [
      botId,
      claimDrop,
      dropClaimHolds,
      generation,
      heldDrops,
      holdDrop,
      key,
      releaseDrop,
      settleDrop,
    ],
  );
  const reading = useMemo<BotComposerReading | null>(
    () =>
      key === null || waiting === null || hold === null
        ? null
        : {
            text: waiting.text,
            replyTo: waiting.replyTo,
            discard: () => discardReadingBox(botId, key),
            cancelReply: () => setReplyTarget(botId, key, null),
            hold,
          },
    [botId, discardReadingBox, hold, key, setReplyTarget, waiting],
  );
  const moved = useMemo<BotComposerCarry | null>(
    () =>
      key === null || carry === null
        ? null
        : {
            blocks: carry.filter(
              (item) =>
                !item.sending && unsent?.held.includes(item.id) !== true,
            ),
          },
    [carry, key, unsent],
  );
  const notice = useMemo<BotComposerNotice | null>(
    () =>
      key === null || boxNotice === null
        ? null
        : {
            ...boxNotice,
            clear: () => noticeBox(botId, key, null),
            clearFailure: () =>
              noticeBox(botId, key, withoutAnswerFailure(boxNotice)),
          },
    [botId, boxNotice, key, noticeBox],
  );
  const keptDraft = useMemo<BotKeptDraft | null>(
    () =>
      key === null
        ? null
        : {
            keep: (text, content, held) =>
              typeThreadBox(botId, key, { text, content, held }),
            carry: (held, stage) => sendCarry(botId, key, held, stage),
            hasDraft: () =>
              useBotDraftsStore.getState().threadBoxes[botId]?.[key] !==
              undefined,
            unsent,
            offer: (message) => offerUnsent(botId, key, message),
            replyTo,
            setReplyTo: (target) => setReplyTarget(botId, key, target),
          },
    [
      botId,
      key,
      offerUnsent,
      replyTo,
      sendCarry,
      setReplyTarget,
      typeThreadBox,
      unsent,
    ],
  );
  return {
    kept,
    seed: keptSeed(kept, draftMoves),
    keptDraft,
    moved,
    notice,
    reading,
    hold,
  };
}

/**
 * What a kept draft puts in the box; `null` for none, and for a draft that
 * holds only the message it replies to, which has nothing to put there and
 * would otherwise empty an edit the box holds.
 */
function keptSeed(
  kept: BotThreadBoxDraft | null,
  draftMoves: ReadonlyArray<BotCarriedBlock> | null,
): BotComposerSeed | null {
  if (kept === null) return null;
  if (
    kept.replyTo !== null &&
    kept.text.length === 0 &&
    kept.content === null
  ) {
    return null;
  }
  return {
    id: kept.seedId,
    text: kept.text,
    content: kept.content,
    held: draftMoves?.map((item) => item.id) ?? [],
  };
}
