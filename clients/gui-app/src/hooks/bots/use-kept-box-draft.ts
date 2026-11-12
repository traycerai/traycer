import { useMemo } from "react";
import type {
  BotComposerCarry,
  BotComposerNotice,
  BotComposerSeed,
  BotKeptDraft,
} from "@/components/bots/bot-message-composer";
import {
  useBotDraftActions,
  useBotDraftsStore,
  type BotThreadBoxDraft,
} from "@/stores/bots/bot-drafts-store";

/**
 * A message box's unsent draft, kept under the bot (`useBotDraftsStore`) by
 * `key` so it outlives the box: what it held loads back into it as a seed,
 * and the box keeps it through `keptDraft`, with a failed send it offers
 * back beside it. Answers moved off question cards wait there for the box
 * to add them (`moved`), beside what the box says about card answers
 * (`notice`): all but those a send still out carries, or the failed send
 * offered back holds, which the box adds only once that send failed or that
 * offer went. `key` is the message a thread hangs off, or the channel's own
 * conversation; `null` keeps nothing. What the box does once its account has
 * retired changes nothing.
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
} {
  const kept = useBotDraftsStore((state) =>
    key === null ? null : (state.threadBoxes[botId]?.[key] ?? null),
  );
  const unsent = useBotDraftsStore((state) =>
    key === null ? null : (state.unsentBoxes[botId]?.[key] ?? null),
  );
  const carry = useBotDraftsStore((state) =>
    key === null ? null : (state.boxCarries[botId]?.[key] ?? null),
  );
  const draftMoves = useBotDraftsStore((state) =>
    key === null ? null : (state.draftMoves[botId]?.[key] ?? null),
  );
  const boxNotice = useBotDraftsStore((state) =>
    key === null ? null : (state.boxNotices[botId]?.[key] ?? null),
  );
  const { typeThreadBox, offerUnsent, sendCarry, noticeBox } =
    useBotDraftActions();
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
        : { ...boxNotice, clear: () => noticeBox(botId, key, null) },
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
          },
    [botId, key, offerUnsent, sendCarry, typeThreadBox, unsent],
  );
  return {
    kept,
    seed:
      kept === null
        ? null
        : {
            id: kept.seedId,
            text: kept.text,
            content: kept.content,
            held: draftMoves?.map((item) => item.id) ?? [],
          },
    keptDraft,
    moved,
    notice,
  };
}
