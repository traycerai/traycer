import { useMemo } from "react";
import type {
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
 * back beside it and the message it replies to. `key` is the message
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
} {
  const kept = useBotDraftsStore((state) =>
    key === null ? null : (state.threadBoxes[botId]?.[key] ?? null),
  );
  const unsent = useBotDraftsStore((state) =>
    key === null ? null : (state.unsentBoxes[botId]?.[key] ?? null),
  );
  const typeThreadBox = useBotDraftsStore((state) => state.typeThreadBox);
  const offerUnsent = useBotDraftsStore((state) => state.offerUnsent);
  const setReplyTarget = useBotDraftsStore((state) => state.setReplyTarget);
  const replyTo = kept?.replyTo ?? null;
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
            replyTo,
            setReplyTo: (target) => setReplyTarget(botId, key, target),
          },
    [botId, key, offerUnsent, replyTo, setReplyTarget, typeThreadBox, unsent],
  );
  return {
    kept,
    seed: keptSeed(kept),
    keptDraft,
  };
}

/**
 * What a kept draft puts in the box; `null` for none, and for a draft that
 * holds only the message it replies to, which has nothing to put there and
 * would otherwise empty an edit the box holds.
 */
function keptSeed(kept: BotThreadBoxDraft | null): BotComposerSeed | null {
  if (kept === null) return null;
  if (
    kept.replyTo !== null &&
    kept.text.length === 0 &&
    kept.content === null
  ) {
    return null;
  }
  return { id: kept.seedId, text: kept.text, content: kept.content };
}
