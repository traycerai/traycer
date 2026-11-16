/**
 * What the suites of the reporting controls going away under an open surface
 * share: the ways the controls go away, the checks on where focus lands, and
 * the sweep of those ways across the surfaces a suite names.
 */
import { type ReactNode, createElement } from "react";
import {
  act,
  render,
  screen,
  within,
  type RenderResult,
} from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  focusMenuItem,
  focusReturns,
  Harness,
  REPORT_METHODS,
  type ReportingSurface,
  periodic,
  reachReportingSurface,
  row,
  task,
} from "@/components/bots/__tests__/bot-activity-page-support";
import type { BotTaskEntry } from "@traycer/protocol/host/bot/schemas";
import { mocks } from "@/components/bots/__tests__/bot-activity-page-mocks";

export const tracking = (): BotTaskEntry => periodic("t-every", {});

const endedFor = (endedReason: "completed" | "archived" | "deleted") =>
  task("t-every", {
    cadence: { kind: "none" },
    state: "ended",
    endedReason,
    inputNeeded: [],
  });

/** A second, untouched row: it holds the focus a person moved on to. */
export const page = (
  tasks: ReadonlyArray<BotTaskEntry>,
  boundHere: boolean,
): ReactNode =>
  createElement(Harness, {
    threads: [],
    tasks: [...tasks, periodic("t-other", {})],
    boundHere,
    notificationSubscriptions: null,
  });

type Way = {
  readonly name: string;
  readonly apply: (view: RenderResult) => void;
  /** Where focus that was on the controls goes: the row survives or not. */
  readonly fallback: "row open button" | "Activity section";
  /** A stop already sent stays pending across loss and restore. */
  readonly keepsDispatched: boolean;
};

export const WAYS: ReadonlyArray<Way> = [
  {
    name: "the task completes",
    apply: (view) => view.rerender(page([endedFor("completed")], true)),
    fallback: "row open button",
    keepsDispatched: false,
  },
  {
    name: "the task is archived",
    apply: (view) => view.rerender(page([endedFor("archived")], true)),
    fallback: "row open button",
    keepsDispatched: false,
  },
  {
    name: "the task is deleted",
    apply: (view) => view.rerender(page([endedFor("deleted")], true)),
    fallback: "Activity section",
    keepsDispatched: false,
  },
  {
    name: "the row leaves the list",
    apply: (view) => view.rerender(page([], true)),
    fallback: "Activity section",
    keepsDispatched: false,
  },
  {
    name: "the tab is bound to another host",
    apply: (view) => view.rerender(page([tracking()], false)),
    fallback: "row open button",
    keepsDispatched: false,
  },
  {
    name: "the negotiated manifest stops offering the methods",
    apply: (view) => {
      mocks.state.supported = new Set();
      view.rerender(page([tracking()], true));
    },
    fallback: "row open button",
    keepsDispatched: true,
  },
];

const expectFocusFellBack = (fallback: Way["fallback"]): void => {
  const region = screen.getByTestId("bot-activity-page");
  if (fallback === "row open button") {
    expect(document.activeElement).toBe(
      region.querySelector(
        '[data-task-id="t-every"] [data-testid="bot-activity-task-open"]',
      ),
    );
  } else {
    expect(document.activeElement).toBe(region);
    expect(region.getAttribute("tabindex")).toBe("-1");
  }
};

const confirmDialog = (): HTMLElement => {
  const found = screen
    .getByText("End reporting?")
    .closest<HTMLElement>('[role="dialog"], [role="alertdialog"]');
  if (found === null) throw new Error("no confirmation dialog");
  return found;
};

/** A stop already sent keeps its modal, and confirming again sends nothing. */
export const expectSentStopHolds = async (
  user: UserEvent,
  dispatched: number,
): Promise<void> => {
  const dialog = confirmDialog();
  await user.click(
    within(dialog).getByRole("button", { name: /^(End reporting|Ending)/ }),
  );
  expect(mocks.actions).toHaveLength(dispatched);
};

export function describeEachSurface(
  surfaces: ReadonlyArray<ReportingSurface>,
): void {
  describe.each(surfaces)("while the %s is up", (surface) => {
    it.each(WAYS)(
      "and $name: nothing of it stays, no request follows, a late answer changes nothing, focus falls back to the agreed target, and a restored row starts fresh",
      async (way) => {
        const user = userEvent.setup();
        mocks.state.supported = new Set(REPORT_METHODS);
        const view = render(page([tracking()], true));
        await reachReportingSurface(user, surface);
        const dispatched = mocks.actions.length;

        way.apply(view);

        if (way.keepsDispatched && surface === "stop in flight") {
          await expectSentStopHolds(user, dispatched);
          act(() => mocks.stop.settle?.("success"));
          expect(screen.queryByText("End reporting?")).toBeNull();
          mocks.state.supported = new Set(REPORT_METHODS);
          view.rerender(page([tracking()], true));
          expect(screen.queryByText("End reporting?")).toBeNull();
          expect(mocks.actions).toHaveLength(dispatched);
          return;
        }
        expect(screen.queryByText("End reporting?")).toBeNull();
        expect(screen.queryByRole("menu")).toBeNull();
        expectFocusFellBack(way.fallback);
        act(() => {
          mocks.stop.settle?.("success");
          mocks.runNow.settle?.();
          mocks.setPaused.settle?.();
        });
        expect(mocks.actions).toHaveLength(dispatched);

        mocks.state.supported = new Set(REPORT_METHODS);
        view.rerender(page([tracking()], true));
        const fresh = within(row("t-every")).getByRole("button", {
          name: "Reporting actions",
        });
        if (!(way.keepsDispatched && surface.endsWith("in flight")))
          expect(fresh.getAttribute("aria-busy")).not.toBe("true");
        expect(screen.queryByText("End reporting?")).toBeNull();
        expect(screen.queryByRole("menu")).toBeNull();
        expect(mocks.actions).toHaveLength(dispatched);
      },
    );
  });
}

export type HeldRequest =
  | "stop in flight"
  | "check-in in flight"
  | "pause in flight";

/**
 * Holds the request and returns once the person is back on the trigger: for
 * a check-in or pause, when the menu has closed; a sent stop keeps its modal
 * until the answer, so there is no focus return to wait for.
 */
const reachHeldRequest = async (
  user: UserEvent,
  surface: HeldRequest,
): Promise<void> => {
  if (surface === "stop in flight") {
    await reachReportingSurface(user, surface);
    return;
  }
  const key = surface === "check-in in flight" ? "runNow" : "setPaused";
  mocks[key].hold = true;
  const trigger = within(row("t-every")).getByRole("button", {
    name: "Reporting actions",
  });
  await focusMenuItem(
    user,
    surface === "check-in in flight" ? "Check in now" : "Pause reports",
  );
  const returned = focusReturns(trigger);
  await user.keyboard("{Enter}");
  await returned;
};

export function describeEachHeldRequest(
  surfaces: ReadonlyArray<HeldRequest>,
): void {
  describe.each(surfaces)(
    "after the person moved on from a held request (%s)",
    (surface) => {
      it.each(WAYS)(
        "and $name: focus stays on what they moved to, after the removal and after the answer",
        async (way) => {
          const user = userEvent.setup();
          mocks.state.supported = new Set(REPORT_METHODS);
          const view = render(page([tracking()], true));
          await reachHeldRequest(user, surface);
          const elsewhere = within(row("t-other")).getByTestId(
            "bot-activity-task-open",
          );
          elsewhere.focus();
          expect(document.activeElement).toBe(elsewhere);

          way.apply(view);

          expect(document.activeElement).toBe(elsewhere);
          act(() => {
            mocks.stop.settle?.("success");
            mocks.runNow.settle?.();
            mocks.setPaused.settle?.();
          });
          expect(document.activeElement).toBe(elsewhere);
        },
        5_000,
      );
    },
  );
}
