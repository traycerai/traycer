// The open list's real-navigation dismissal, isolated from the broad
// `chat-turn-minimap.test.tsx` suite: that suite never wraps the component in
// a router, so `useRouter({ warn: false })` resolves to `undefined` there and
// the dismissal effect never runs at all. This suite supplies a REAL
// `RouterContextProvider` over a memory history - the same technique
// `mobile-history-swipe-navigation.test.tsx` uses for the desktop/mobile
// gesture suites - so `router.history.subscribe` sees genuine navigations
// rather than a mock. Gesture recognition itself is out of scope here; only
// the wiring from a history notification to `setOpen` is under test.
import type { LegendListRef } from "@legendapp/list/react";
import {
  RouterContextProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatTurnMinimap } from "@/components/chat/chat-turn-minimap";
import { transcriptListRows } from "@/stores/chats/transcript-list-rows";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import {
  DEFAULT_UI_FONT_SIZE,
  useSettingsStore,
} from "@/stores/settings/settings-store";
import { makeMessage } from "./chat-message-fixtures";

function user(index: number, content: string): ChatMessageModel {
  return { ...makeMessage(index, "user"), content };
}

function assistant(index: number, content: string): ChatMessageModel {
  return { ...makeMessage(index, "assistant"), content };
}

function makeTranscript(turnCount: number): ChatMessageModel[] {
  return Array.from({ length: turnCount }, (_unused, index) => [
    user(index * 2, `Question ${index}`),
    assistant(index * 2 + 1, `Reply ${index}`),
  ]).flat();
}

function makeListRef(input: {
  readonly scroll: number;
  readonly scrollLength: number;
}): RefObject<LegendListRef | null> {
  const list: Pick<LegendListRef, "getState"> = {
    getState: () =>
      ({
        scroll: input.scroll,
        scrollLength: input.scrollLength,
        positionAtIndex: (index: number) => index * 100,
        sizeAtIndex: () => 100,
      }) as never,
  };
  return { current: list as LegendListRef };
}

async function flushFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
}

/**
 * A minimal router over a real memory history, rendered straight into the
 * component - no route content is ever matched (this suite never mounts
 * `<RouterProvider>`/`<Outlet>`), only `router.history` is read, exactly as
 * `ChatTurnMinimap` reads it. Kept as one function (rather than a router
 * builder plus a separate render step) so the router's own generic type
 * never has to be named or threaded through a second function signature.
 */
function renderMinimap() {
  const rootRoute = createRootRoute();
  const anyRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => null,
  });
  const history = createMemoryHistory({ initialEntries: ["/chat-a"] });
  const router = createRouter({
    routeTree: rootRoute.addChildren([anyRoute]),
    history,
  });

  const viewport = document.createElement("div");
  viewport.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    width: 1200,
    height: 600,
    top: 0,
    right: 1200,
    bottom: 600,
    left: 0,
    toJSON: () => ({}),
  });
  document.body.append(viewport);
  render(
    <RouterContextProvider router={router}>
      <ChatTurnMinimap
        bottomInset={0}
        inViewRefreshRef={{ current: () => undefined }}
        listRef={makeListRef({ scroll: 1050, scrollLength: 160 })}
        rows={transcriptListRows({
          window: null,
          rendered: makeTranscript(12),
        })}
        transcriptWindow={null}
        onSelect={vi.fn<(messageId: string) => void>()}
        side="right"
        topOffsetAdjustmentRef={{ current: 0 }}
        viewportRef={{ current: viewport }}
      />
    </RouterContextProvider>,
  );
  return { router };
}

async function openMinimap(): Promise<void> {
  await flushFrame();
  fireEvent.mouseEnter(
    screen.getByRole("group", { name: "Message minimap controls" }),
  );
  expect(screen.getByTestId("chat-turn-minimap-card")).toBeTruthy();
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  useSettingsStore.setState({ uiFontSize: DEFAULT_UI_FONT_SIZE });
});

describe("ChatTurnMinimap dismissal on real router.history navigation", () => {
  it("closes the open list once the route pushes to a different href", async () => {
    const { router } = renderMinimap();
    await openMinimap();

    act(() => {
      router.history.push("/chat-b");
    });

    expect(screen.queryByTestId("chat-turn-minimap-card")).toBeNull();
  });

  // The shape a resolved-to-nothing navigation attempt takes on the wire - a
  // canceled desktop-history gesture never calls `history.go` at all, so it
  // notifies nothing; a `go`/`replace` that lands back where it started still
  // notifies, just with an unchanged href. Both must leave the list open, and
  // this pins the latter, which is the one the effect's own href comparison
  // actually has to get right.
  it("leaves the open list open on a same-href history notification", async () => {
    const { router } = renderMinimap();
    await openMinimap();

    act(() => {
      router.history.notify({ type: "REPLACE" });
    });

    expect(screen.getByTestId("chat-turn-minimap-card")).toBeTruthy();
  });

  // The href-only comparison used to miss this: A -> B -> A (a fresh push,
  // not "back", so it is a NEW entry with its own __TSR_key) -> open the list
  // here -> back TWO steps, skipping the closed "/chat-b" entry entirely and
  // landing on the ORIGINAL "/chat-a" entry. Same href as origin, but an
  // older entry with a different key - the list must still close.
  it("closes the open list when back navigation skips over a closed entry and lands on an older entry with the same href", async () => {
    const { router } = renderMinimap();
    act(() => {
      router.history.push("/chat-b");
    });
    act(() => {
      router.history.push("/chat-a");
    });
    await openMinimap();

    act(() => {
      router.history.go(-2);
    });

    expect(screen.queryByTestId("chat-turn-minimap-card")).toBeNull();
  });

  it("leaves the list open when it was never opened for a route that happens to change", async () => {
    const { router } = renderMinimap();
    await flushFrame();
    expect(screen.queryByTestId("chat-turn-minimap-card")).toBeNull();

    // The dismissal effect only subscribes while `open`, so a navigation with
    // nothing open must be inert rather than throwing on a stale subscription.
    act(() => {
      router.history.push("/chat-b");
    });

    expect(screen.queryByTestId("chat-turn-minimap-card")).toBeNull();
  });
});
