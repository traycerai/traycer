import { useMemo } from "react";
import type { HomeBotsModel } from "@/lib/home-bots/bots-model";
import { arrangeBotsModel } from "@/lib/home-bots/arrange-bots-model";
import { useBotColumnLayoutStore } from "@/stores/bots/bot-column-layout-store";

/**
 * The model in the order the person gave the channel column (decision 151),
 * read by the column and by Home's bots section so the two agree.
 */
export function useArrangedBotsModel(model: HomeBotsModel): HomeBotsModel {
  const sectionOrder = useBotColumnLayoutStore((state) => state.sectionOrder);
  const channelOrder = useBotColumnLayoutStore((state) => state.channelOrder);
  return useMemo(
    () => arrangeBotsModel(model, { sectionOrder, channelOrder }),
    [model, sectionOrder, channelOrder],
  );
}
