/**
 * What `bot-tab-surface.test.tsx` and `bot-tab-surface-header.test.tsx` render
 * each case: the surface over the case's QueryClient, and the lifecycle that
 * makes that client and resets the mocked boundaries before a case and ends
 * the case after it. Both files read `queryClient` to wrap what they render
 * themselves.
 */
import { StrictMode, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach } from "vitest";
import { BotTabSurface } from "@/components/bots/bot-tab-surface";
import {
  BOT_ID,
  endBotTabSurfaceCase,
  resetBotTabSurfaceMocks,
  TAB_HOST,
} from "./bot-tab-surface-harness";

export let queryClient = new QueryClient();

export function surfaceFor(botId: string | null): ReactNode {
  return (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BotTabSurface botId={botId} hostId={TAB_HOST} />
      </QueryClientProvider>
    </StrictMode>
  );
}

export function surface(): ReactNode {
  return surfaceFor(BOT_ID);
}

export function installBotTabSurfaceCaseLifecycle(): void {
  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    resetBotTabSurfaceMocks();
  });

  afterEach(() => {
    endBotTabSurfaceCase(queryClient);
  });
}
