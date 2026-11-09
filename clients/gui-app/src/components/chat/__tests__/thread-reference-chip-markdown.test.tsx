/**
 * A thread id in a message is a chip (Tracy Bots T160), drawn through the real
 * markdown path (`TextSegment` -> `AgentReferenceMarkdown` -> the reference
 * plugin -> `AgentReferenceChip`), with the threads read from a real query
 * cache holding a bot's `bot.thread.list` answer as `useBotThreadListQuery`
 * keeps it. A thread the window holds is the chip: the bot's picture,
 * "thread" and the post's first words. Anything else stays as written.
 */
import { StrictMode, type ReactNode } from "react";
import { act, cleanup, render, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOT_ID,
  EXCERPT,
  HOST_ID,
  OTHER_BOT_ID,
  SIBLING_THREAD_ID,
  THREAD_ID,
  UNRELATED_THREAD_ID,
  holdThreads,
  threadSummary,
} from "@/components/chat/__tests__/thread-reference-chip-support";
import { TextSegment } from "@/components/chat/segments/text-segment";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  EpicSessionContext,
  handleHostIds,
} from "@/lib/registries/epic-session-registry";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";

// No host behind the markdown: a token that is no held thread reaches the
// task chip, which keeps it as written without one.
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useOptionalHostClient: () => null,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
  useRouter: () => ({ state: { location: { pathname: "/" } } }),
}));
vi.mock("@/hooks/host/use-connectable-host-ids", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-connectable-host-ids")
  >()),
  useConnectableHostIds: () => ({ hostIds: [HOST_ID], resolved: true }),
}));
// The open epic names no agent.
vi.mock("@/lib/epic-selectors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/epic-selectors")>()),
  useEpicArtifactRecords: () => [],
  useEpicAgentRoleClaimsByAgentId: () => ({}),
  useOpenEpicId: () => "epic-1",
  useEpicChatHarnessId: () => null,
  useMaybeEpicTuiAgentHarnessId: () => null,
}));

let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient();
});

afterEach(() => {
  cleanup();
});

function Providers(props: { readonly children: ReactNode }): ReactNode {
  return (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>{props.children}</TooltipProvider>
      </QueryClientProvider>
    </StrictMode>
  );
}

function renderMarkdown(markdown: string): HTMLElement {
  return render(
    <TextSegment
      findUnitId={null}
      markdown={markdown}
      isStreaming={false}
      nextStepActions={null}
    />,
    { wrapper: Providers },
  ).container;
}

/** An open epic behind the markdown, none of whose agents the token names. */
function renderInOpenEpic(markdown: string): HTMLElement {
  const handle = {} as OpenEpicStoreHandle;
  handleHostIds.set(handle, HOST_ID);
  return render(
    <EpicSessionContext value={handle}>
      <TextSegment
        findUnitId={null}
        markdown={markdown}
        isStreaming={false}
        nextStepActions={null}
      />
    </EpicSessionContext>,
    { wrapper: Providers },
  ).container;
}

function holdOne(threadId: string): void {
  holdThreads(queryClient, [threadSummary(threadId, EXCERPT)], {
    botId: BOT_ID,
    hostId: HOST_ID,
  });
}

function chipOf(container: HTMLElement, threadId: string): HTMLElement {
  const chip = container.querySelector<HTMLElement>(
    `[data-thread-reference="${threadId}"]`,
  );
  if (chip === null) throw new Error(`no chip for thread ${threadId}`);
  return chip;
}

function chips(container: HTMLElement): NodeListOf<Element> {
  return container.querySelectorAll("[data-thread-reference]");
}

describe("a thread id in a message", () => {
  it("is the chip of a thread the window holds: the bot's picture, 'thread' and the post's first words", () => {
    holdOne(THREAD_ID);

    const container = renderMarkdown(
      `Delivered to thread ${THREAD_ID} just now`,
    );

    const chip = chipOf(container, THREAD_ID);
    expect(chip.getAttribute("data-bot-id")).toBe(BOT_ID);
    expect(within(chip).getByTestId("bot-avatar")).not.toBeNull();
    expect(chip.textContent).toBe(`thread${EXCERPT}`);
    expect(container.textContent).not.toContain(THREAD_ID);
  });

  it("is the chip of the one held thread an 8-character prefix of its id begins", () => {
    holdOne(THREAD_ID);

    const container = renderMarkdown(`see ${THREAD_ID.slice(0, 8)} for it`);

    expect(chipOf(container, THREAD_ID).textContent).toBe(`thread${EXCERPT}`);
  });

  it("names the bot whose list holds it, on any host", () => {
    holdThreads(queryClient, [threadSummary(THREAD_ID, EXCERPT)], {
      botId: OTHER_BOT_ID,
      hostId: "host-sibling",
    });

    const container = renderMarkdown(THREAD_ID);

    expect(chipOf(container, THREAD_ID).getAttribute("data-bot-id")).toBe(
      OTHER_BOT_ID,
    );
  });

  it("stays as written when no list holds it", () => {
    holdOne(UNRELATED_THREAD_ID);

    const container = renderMarkdown(
      `thread ${THREAD_ID} and ${THREAD_ID.slice(0, 8)}`,
    );

    expect(chips(container)).toHaveLength(0);
    expect(container.textContent).toBe(
      `thread ${THREAD_ID} and ${THREAD_ID.slice(0, 8)}`,
    );
  });

  it("stays as written when a prefix is the start of two held threads", () => {
    holdThreads(
      queryClient,
      [
        threadSummary(THREAD_ID, EXCERPT),
        threadSummary(SIBLING_THREAD_ID, "Another post"),
      ],
      { botId: BOT_ID, hostId: HOST_ID },
    );
    const prefix = THREAD_ID.slice(0, 8);

    const container = renderMarkdown(`see ${prefix}`);

    expect(chips(container)).toHaveLength(0);
    expect(container.textContent).toBe(`see ${prefix}`);
  });

  it("is the chip of the thread it names in full, before one it only begins", () => {
    const shortId = THREAD_ID.slice(0, 8);
    holdThreads(
      queryClient,
      [
        threadSummary(SIBLING_THREAD_ID, "The longer id"),
        threadSummary(shortId, "The exact id"),
      ],
      { botId: BOT_ID, hostId: HOST_ID },
    );

    const container = renderMarkdown(`see ${shortId}`);

    expect(chips(container)).toHaveLength(1);
    expect(chipOf(container, shortId).textContent).toBe("threadThe exact id");
  });

  it("is the chip when written as inline code", () => {
    holdOne(THREAD_ID);

    const container = renderMarkdown(`see \`${THREAD_ID}\``);

    expect(chipOf(container, THREAD_ID).textContent).toBe(`thread${EXCERPT}`);
  });

  it("is a chip inside an open epic whose agents it names none of", () => {
    holdOne(THREAD_ID);

    const container = renderInOpenEpic(THREAD_ID);

    expect(chips(container)).toHaveLength(1);
  });

  it("draws a thread that arrives in the window after the message did", () => {
    const container = renderMarkdown(THREAD_ID);
    expect(chips(container)).toHaveLength(0);

    act(() => holdOne(THREAD_ID));

    expect(chips(container)).toHaveLength(1);
  });

  it("shows just the bot and 'thread' when the post has no first words", () => {
    holdThreads(queryClient, [threadSummary(THREAD_ID, null)], {
      botId: BOT_ID,
      hostId: HOST_ID,
    });

    const container = renderMarkdown(THREAD_ID);

    expect(chipOf(container, THREAD_ID).textContent).toBe("thread");
  });

  it("reads the window's thread lists once for all the ids in a message, and once more per change to them", () => {
    const scansAfterRender = (tokenCount: number): (() => number) => {
      queryClient = new QueryClient();
      holdOne(UNRELATED_THREAD_ID);
      const spy = vi.spyOn(queryClient.getQueryCache(), "findAll");
      const tokens = Array.from({ length: tokenCount }, (_, index) =>
        index.toString(16).padStart(8, "a"),
      );
      renderMarkdown(`see ${tokens.join(" ")}`);
      return () => spy.mock.calls.length;
    };

    const scansForOne = scansAfterRender(1)();
    cleanup();
    const twenty = scansAfterRender(20);

    expect(scansForOne).toBeGreaterThan(0);
    expect(twenty()).toBe(scansForOne);

    act(() => {
      holdThreads(queryClient, [threadSummary(UNRELATED_THREAD_ID, EXCERPT)], {
        botId: OTHER_BOT_ID,
        hostId: HOST_ID,
      });
    });

    expect(twenty()).toBe(scansForOne * 2);
    expect(document.querySelectorAll("[data-thread-reference]")).toHaveLength(
      0,
    );
  });
});
