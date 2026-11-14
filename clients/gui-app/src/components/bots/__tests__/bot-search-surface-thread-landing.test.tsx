/**
 * A search result that is a reply opens its thread in the rail at the reply
 * (`landThread`). That landing belongs to the search that opened the thread:
 * the search store is reset only by `closeBotSearch`, so a history step that
 * sets the rail to the same thread as a plain thread must not land again.
 * Observed through the REAL `BotTabSurface` and the REAL thread panel; the
 * transcript is the suite's stub, whose `data-land-on` is the `landOn` the
 * panel handed it.
 */
import {
  mocks,
  SEARCH_RESULT_A,
  answerWith,
  settle,
  changeLists,
  thread,
  THREAD_HIT,
  hitRows,
  transcriptOf,
  installSearchSurfaceLifecycle,
} from "./bot-search-surface-support";
import { Surface } from "./bot-search-surface-view";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  SEARCH_BOT_A,
  searchResponse,
} from "@/lib/bots/__tests__/bot-search-test-support";
import {
  useBotOpenThreadStore,
  type BotRail,
} from "@/stores/bots/bot-open-thread-store";

installSearchSurfaceLifecycle();

const PLAIN_THREAD: BotRail = {
  kind: "thread",
  anchorMessageId: "post-7",
  announcement: false,
  anchorKind: null,
  sent: null,
};

function setRail(rail: BotRail | null): void {
  act(() => {
    useBotOpenThreadStore.getState().setRail(SEARCH_BOT_A, rail);
  });
}

function landedOn(): string | undefined {
  return transcriptOf("thread-1").dataset.landOn;
}

/** Opens the search, clicks the reply result, and leaves its thread landed. */
async function openThreadFromSearch(): Promise<BotRail> {
  mocks.state.threads = [thread("thread-1", "post-7")];
  mocks.state.answer = answerWith(
    searchResponse({ hits: [THREAD_HIT, SEARCH_RESULT_A], total: 2 }),
  );
  render(<Surface />);
  fireEvent.change(screen.getByTestId("bot-column-search"), {
    target: { value: "release" },
  });
  await settle();
  fireEvent.click(hitRows()[0]);
  await settle();

  const rail = useBotOpenThreadStore.getState().byBotId[SEARCH_BOT_A];
  expect(rail.kind).toBe("search");
  expect(landedOn()).toBe("reply-2");
  return rail;
}

describe("a reply result's landing in its thread", () => {
  it("is gone once a history step shows the same thread as a plain thread", async () => {
    await openThreadFromSearch();

    setRail(null);
    expect(screen.queryByTestId("bot-thread-panel")).toBeNull();
    setRail(PLAIN_THREAD);

    expect(screen.getByTestId("bot-thread-panel")).toBeTruthy();
    expect(landedOn()).toBe("none");
  });

  it("is gone after the memory takes the rail and the thread comes back as a plain thread", async () => {
    await openThreadFromSearch();

    setRail({ kind: "memory", back: null });
    expect(screen.queryByTestId("bot-thread-panel")).toBeNull();
    setRail(PLAIN_THREAD);

    expect(screen.getByTestId("bot-thread-panel")).toBeTruthy();
    expect(landedOn()).toBe("none");
  });

  it("is asked again by clicking the same result from the results the search rail still holds", async () => {
    await openThreadFromSearch();

    fireEvent.click(screen.getByTestId("bot-search-back"));
    await settle();
    expect(screen.queryByTestId("bot-thread-panel")).toBeNull();
    fireEvent.click(hitRows()[0]);
    await settle();

    expect(screen.getByTestId("bot-thread-panel")).toBeTruthy();
    expect(landedOn()).toBe("reply-2");
  });

  it("stays while the search still shows the thread and the view re-renders", async () => {
    const rail = await openThreadFromSearch();

    changeLists(() => {});

    expect(useBotOpenThreadStore.getState().byBotId[SEARCH_BOT_A]).toBe(rail);
    expect(landedOn()).toBe("reply-2");
  });
});
