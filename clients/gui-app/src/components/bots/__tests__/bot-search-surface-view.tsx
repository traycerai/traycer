import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { searchQueryClient, TAB_HOST } from "./bot-search-surface-support";
import { BotTabSurface } from "@/components/bots/bot-tab-surface";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";

/** The real surface of the channel the Tracy store has selected. */
export function Surface(): ReactNode {
  // The route would pass the channel the controller committed.
  const botId = useTracySurfaceStore((state) => state.botId);
  return (
    <QueryClientProvider client={searchQueryClient()}>
      <TooltipProvider>
        <BotTabSurface botId={botId} hostId={TAB_HOST} />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
