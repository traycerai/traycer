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
 * and the box keeps and spends it through `keptDraft`. `key` is the message
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
  const typeThreadBox = useBotDraftsStore((state) => state.typeThreadBox);
  const spendThreadBox = useBotDraftsStore((state) => state.spendThreadBox);
  const keptDraft = useMemo<BotKeptDraft | null>(
    () =>
      key === null
        ? null
        : {
            keep: (text) => typeThreadBox(botId, key, text),
            revision: () =>
              useBotDraftsStore.getState().threadBoxes[botId]?.[key]
                ?.revision ?? null,
            spend: (revision) => spendThreadBox(botId, key, revision),
          },
    [botId, key, spendThreadBox, typeThreadBox],
  );
  return {
    kept,
    seed: kept === null ? null : { id: kept.seedId, text: kept.text },
    keptDraft,
  };
}
