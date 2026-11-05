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
 * back beside it. `key` is the message
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
  const keptDraft = useMemo<BotKeptDraft | null>(
    () =>
      key === null
        ? null
        : {
            keep: (text) => typeThreadBox(botId, key, text),
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
    seed: kept === null ? null : { id: kept.seedId, text: kept.text },
    keptDraft,
  };
}
