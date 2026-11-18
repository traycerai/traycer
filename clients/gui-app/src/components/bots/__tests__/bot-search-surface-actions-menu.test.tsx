/**
 * The compact Channel actions menu, through the REAL phone header, the REAL
 * `BotTabSurface`, the REAL search panel and the REAL settings panel, whose
 * model picker and usage dialog are stand-ins. The channel's composer and
 * Threads stay stand-ins; the fake hosts are those of
 * `bot-search-surface-support.tsx`.
 */
import "./bot-search-surface-stub-composer";
import "./bot-search-surface-stub-threads";
import "./bot-search-surface-stub-settings-children";
import { UnderHeader } from "./bot-search-surface-under-header";
import { installSearchSurfaceLifecycle } from "./bot-search-surface-support";
import {
  actionsTrigger,
  choose,
  installCompactHeaderLifecycle,
  menuFullyClosed,
  openMenu,
  required,
  step,
  userEvents,
} from "./bot-search-surface-compact-support";
import { PaneSurfaceActivityContext } from "@/components/epic-tabs/pane-visibility-context";
import {
  SEARCH_BOT_A,
  SEARCH_BOT_B,
} from "@/lib/bots/__tests__/bot-search-test-support";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import {
  act,
  fireEvent,
  render,
  screen,
  within,
  type RenderResult,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

installSearchSurfaceLifecycle();

describe("from the compact Channel actions menu", () => {
  installCompactHeaderLifecycle();

  it.each(["pointer", "keyboard"] as const)(
    "opens Search with the field focused and typeable after a %s choice",
    async (how) => {
      const user = userEvents();
      render(<UnderHeader />);

      const menu = await openMenu(user);
      await choose(user, how, within(menu).getByText(/^Search/));
      await menuFullyClosed();

      const input = screen.getByTestId("bot-search-input");
      expect(document.activeElement).toBe(input);
      await step("typing into the focused field", () =>
        user.keyboard("release"),
      );
      expect(input).toHaveProperty("value", "release");
    },
  );

  it.each(["pointer", "keyboard"] as const)(
    "opens the channel settings focused, and Escape closes them, after a %s choice",
    async (how) => {
      const user = userEvents();
      render(<UnderHeader />);

      const menu = await openMenu(user);
      await choose(user, how, within(menu).getByText(/settings/i));
      await menuFullyClosed();

      expect(document.activeElement).toBe(required("bot-channel-settings"));
      await step("Escape in the settings panel", () =>
        user.keyboard("{Escape}"),
      );
      expect(screen.queryByTestId("bot-channel-settings")).toBeNull();
    },
  );

  it("hands focus back to the trigger when the menu is dismissed without a choice", async () => {
    const user = userEvents();
    render(<UnderHeader />);

    await openMenu(user);
    await step("Escape on the open menu", () => user.keyboard("{Escape}"));
    await menuFullyClosed();

    expect(document.activeElement).toBe(actionsTrigger());
  });

  it.each(["Activity", "Messages"] as const)(
    "hands focus back to the trigger after choosing %s",
    async (view) => {
      const user = userEvents();
      render(<UnderHeader />);

      const menu = await openMenu(user);
      await step(`click on the ${view} item`, () =>
        user.click(
          within(menu).getByRole("menuitemradio", {
            name: new RegExp(`^${view}`),
          }),
        ),
      );
      await menuFullyClosed();

      expect(document.activeElement).toBe(actionsTrigger());
      expect(
        screen
          .getByTestId(`bot-tab-view-${view.toLowerCase()}`)
          .getAttribute("aria-selected"),
      ).toBe("true");
    },
  );

  describe.each([
    ["Search", /^Search/, "bot-search-input"],
    ["settings", /settings/i, "bot-channel-settings"],
  ] as const)(
    "a %s choice whose menu has not handed focus back",
    (name, item, opened) => {
      function inPane(focused: boolean): ReactNode {
        return (
          <PaneSurfaceActivityContext.Provider
            value={{ visible: true, focused }}
          >
            <UnderHeader />
          </PaneSurfaceActivityContext.Provider>
        );
      }

      function interrupt(
        how: "blur" | "other bot" | "unmount",
        view: RenderResult,
      ): void {
        if (how === "blur") view.rerender(inPane(false));
        else if (how === "other bot")
          act(() =>
            useTracySurfaceStore.getState().selectChannel(SEARCH_BOT_B),
          );
        else view.unmount();
      }

      // The clock is fake from before the menu opens, so the timers Radix queues
      // when it closes (the focus hand-back) run only when a case advances it.
      beforeEach(() => {
        vi.useFakeTimers();
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      /** Runs every timer due within a second, through the menu's close and focus hand-back. */
      async function advance(): Promise<void> {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
      }

      // The choice is fired inside `act`, which runs no timers: the hand-back is
      // still queued when the case interrupts, with no advance between them.
      async function chooseWithoutAdvancing(): Promise<void> {
        act(() => {
          fireEvent.keyDown(actionsTrigger(), { key: "Enter" });
        });
        await advance();
        const menu = screen.getByRole("menu");
        const target = within(menu).getByText(item);
        act(() => {
          fireEvent.click(target);
        });
      }

      it("runs the choice once the hand-back is reached with nothing interrupting (control)", async () => {
        render(inPane(true));
        await chooseWithoutAdvancing();
        expect(
          screen.queryByTestId(opened),
          "the hand-back already ran before the control looked",
        ).toBeNull();

        await advance();

        expect(screen.queryByRole("menu")).toBeNull();
        expect(required(opened)).toBeTruthy();
      });

      async function interruptedChoiceStaysDropped(
        how: "blur" | "other bot" | "unmount",
      ): Promise<void> {
        const view = render(inPane(true));
        await chooseWithoutAdvancing();
        expect(
          screen.queryByTestId(opened),
          "the hand-back already ran, so there is nothing to interrupt",
        ).toBeNull();
        interrupt(how, view);
        await advance();
        expect(screen.queryByTestId(opened)).toBeNull();
        if (how === "unmount") render(inPane(true));
        else view.rerender(inPane(true));
        await advance();
        expect(screen.queryByTestId(opened)).toBeNull();
      }

      it.each(
        name === "Search"
          ? (["blur", "unmount"] as const)
          : (["blur"] as const),
      )(
        "is dropped, and never run later, when the interruption is: %s",
        (how) => interruptedChoiceStaysDropped(how),
      );

      if (name === "Search") {
        it("leaves the original bot's rail alone when another bot's channel replaces it", async () => {
          const before = useBotOpenThreadStore.getState().byBotId[SEARCH_BOT_A];
          await interruptedChoiceStaysDropped("other bot");
          expect(useBotOpenThreadStore.getState().byBotId[SEARCH_BOT_A]).toBe(
            before,
          );
        });
      } else {
        it("does not open settings in the replacement bot from the old choice", async () => {
          await interruptedChoiceStaysDropped("other bot");
        });
      }
    },
  );
});
