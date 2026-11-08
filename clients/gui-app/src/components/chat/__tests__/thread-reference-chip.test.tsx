/**
 * Pressing a thread's chip opens its bot's channel with the thread panel on
 * that thread (Tracy Bots T160): the REAL `useOpenBotChannel` and
 * `openBotChannel` run, so what is asserted is what they do - the landing the
 * bot's channel is asked for and the navigation to that channel - with only
 * the router seam (`activateTabIntent`) and the directory's answer on which
 * hosts can be dialed replaced.
 */
import { StrictMode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOT_ID,
  EXCERPT,
  HOST_ID,
  OTHER_BOT_ID,
  THREAD_ID,
  holdThreads,
  threadSummary,
} from "@/components/chat/__tests__/thread-reference-chip-support";
import { ThreadReferenceChip } from "@/components/chat/thread-reference-chip";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useBotTabLandingStore } from "@/stores/bots/bot-tab-landing-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";

const mocks = vi.hoisted(() => ({
  activateTabIntent: vi.fn<(intent: unknown) => void>(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
  useRouter: () => ({ state: { location: { pathname: "/" } } }),
}));
// A navigation just issued has not committed its channel yet: it stays in
// flight, so the landing staged for it is not withdrawn as never landed.
vi.mock("@/lib/tab-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tab-navigation")>()),
  activateTabIntent: (_navigate: unknown, intent: unknown) => {
    mocks.activateTabIntent(intent);
    return true;
  },
  tracyChannelNavigationPending: () => true,
}));
vi.mock("@/hooks/host/use-connectable-host-ids", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-connectable-host-ids")
  >()),
  useConnectableHostIds: () => ({ hostIds: [HOST_ID], resolved: true }),
}));

let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient();
  vi.clearAllMocks();
  useBotTabLandingStore.setState({ byBotId: {} });
  useSelectionAuthorityStore.setState({ effectiveHostId: HOST_ID });
  useTracySurfaceStore.setState({
    open: false,
    hostId: null,
    botId: null,
    visitedBotIds: [],
  });
});

afterEach(() => {
  cleanup();
});

function mount(referenceId: string): void {
  render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ThreadReferenceChip referenceId={referenceId} display="text" />
        </TooltipProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

describe("<ThreadReferenceChip /> pressed", () => {
  it("asks the thread's bot's channel to land on that thread, and opens the surface on that channel", async () => {
    holdThreads(queryClient, [threadSummary(THREAD_ID, EXCERPT)], {
      botId: OTHER_BOT_ID,
      hostId: HOST_ID,
    });
    mount(THREAD_ID);

    await userEvent.setup().click(screen.getByRole("button"));

    expect(useBotTabLandingStore.getState().byBotId).toEqual({
      [OTHER_BOT_ID]: { kind: "thread", threadId: THREAD_ID, messageId: null },
    });
    expect(useTracySurfaceStore.getState()).toMatchObject({
      open: true,
      hostId: HOST_ID,
    });
    expect(mocks.activateTabIntent).toHaveBeenCalledExactlyOnceWith({
      kind: "tracy",
      botId: OTHER_BOT_ID,
    });
  });

  it("lands the thread of a prefix the chip was written with, by the thread's full id", async () => {
    holdThreads(queryClient, [threadSummary(THREAD_ID, EXCERPT)], {
      botId: BOT_ID,
      hostId: HOST_ID,
    });
    mount(THREAD_ID.slice(0, 8));

    await userEvent.setup().click(screen.getByRole("button"));

    expect(useBotTabLandingStore.getState().byBotId).toEqual({
      [BOT_ID]: { kind: "thread", threadId: THREAD_ID, messageId: null },
    });
  });
});
