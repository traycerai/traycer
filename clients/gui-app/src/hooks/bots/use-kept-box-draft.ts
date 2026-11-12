import { useMemo } from "react";
import type {
  BotComposerCarry,
  BotComposerNotice,
  BotComposerSeed,
  BotKeptDraft,
} from "@/components/bots/bot-message-composer";
import {
  useBotDraftsStore,
  type BotThreadBoxDraft,
} from "@/stores/bots/bot-drafts-store";

/**
 * A message box's unsent draft, kept under the bot (`useBotDraftsStore`) by
 * `key` so it outlives the box: what it held loads back into it as a seed,
 * and the box keeps it through `keptDraft`, with a failed send it offers
 * back beside it. Answers moved off question cards wait there for the box
 * to add them (`moved`), beside what the box says about card answers
 * (`notice`). `key` is the message
 * a thread hangs off, or the channel's own conversation; `null` keeps
 * nothing.
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
  const boxNotice = useBotDraftsStore((state) =>
    key === null ? null : (state.boxNotices[botId]?.[key] ?? null),
  );
  const typeThreadBox = useBotDraftsStore((state) => state.typeThreadBox);
  const offerUnsent = useBotDraftsStore((state) => state.offerUnsent);
  const takeCarry = useBotDraftsStore((state) => state.takeCarry);
  const noticeBox = useBotDraftsStore((state) => state.noticeBox);
  const moved = useMemo<BotComposerCarry | null>(
    () =>
      key === null || carry === null
        ? null
        : {
            id: carry.id,
            blocks: carry.blocks,
            taken: () => takeCarry(botId, key, carry.id),
          },
    [botId, carry, key, takeCarry],
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
            keep: (text, content) => typeThreadBox(botId, key, text, content),
            hasDraft: () =>
              useBotDraftsStore.getState().threadBoxes[botId]?.[key] !==
              undefined,
            unsent,
            offer: (message) => offerUnsent(botId, key, message),
          },
    [botId, key, offerUnsent, typeThreadBox, unsent],
  );
  return {
    kept,
    seed:
      kept === null
        ? null
        : { id: kept.seedId, text: kept.text, content: kept.content },
    keptDraft,
    moved,
    notice,
  };
}
