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
  drainZeroDelayTimers,
  installCompactHeaderLifecycle,
  menuFullyClosed,
  openMenu,
  required,
  step,
  userEvents,
} from "./bot-search-surface-compact-support";
import { PaneSurfaceActivityContext } from "@/components/epic-tabs/pane-visibility-context";
import { SEARCH_BOT_B } from "@/lib/bots/__tests__/bot-search-test-support";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import {
  act,
  fireEvent,
  render,
  screen,
  within,
  type RenderResult,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

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
    (_name, item, opened) => {
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

      // The choice is fired synchronously inside `act`, which does not run
      // timers: the zero-delay timer that hands focus back is still queued when
      // the interruption lands, with no await between them.
      async function chooseWithoutYielding(): Promise<void> {
        const user = userEvent.setup({ delay: null });
        const menu = await openMenu(user);
        const target = within(menu).getByText(item);
        act(() => {
          fireEvent.click(target);
        });
      }

      it("runs the choice once the hand-back is reached with nothing interrupting (control)", async () => {
        render(inPane(true));
        await chooseWithoutYielding();
        expect(
          screen.queryByTestId(opened),
          "the hand-back already ran before the control looked",
        ).toBeNull();

        await drainZeroDelayTimers();

        expect(required(opened)).toBeTruthy();
      });

      it.each(["blur", "other bot", "unmount"] as const)(
        "is dropped, and never run later, when the interruption is: %s",
        async (how) => {
          const view = render(inPane(true));
          await chooseWithoutYielding();
          expect(
            screen.queryByTestId(opened),
            "the hand-back already ran, so there is nothing to interrupt",
          ).toBeNull();

          interrupt(how, view);
          await drainZeroDelayTimers();

          expect(screen.queryByTestId(opened)).toBeNull();
          if (how === "unmount") render(inPane(true));
          else view.rerender(inPane(true));
          await drainZeroDelayTimers();
          expect(screen.queryByTestId(opened)).toBeNull();
        },
      );
    },
  );
});
